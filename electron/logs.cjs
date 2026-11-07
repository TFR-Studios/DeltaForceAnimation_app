/* ============================================================================
 * 三角洲行动动画编辑器 · 日志持久化(主进程)
 *
 * 日志页上的每条记录都由渲染进程产生,但**存哪儿、怎么存**必须由主进程决定:
 * 渲染进程没有文件系统权限(见 main.cjs 的 webPreferences),也不该有。
 *
 * 文件布局(<userData>/logs/):
 *   dfae.log     当前文件,JSONL —— 一行一条记录;
 *   dfae.1.log   上一代(只保留一代)。当前文件超过 2MB 时,把当前文件改名为它。
 *
 * 为什么用 JSONL 而不是纯文本:
 *   · 记录本身带 id/t/level/tag,界面要按级别和标签筛选;纯文本还得再解析一遍,
 *     而「消息里本来就带冒号、方括号」时纯文本解析必然出错;
 *   · 一行一条,写盘就是纯追加(appendFile),不需要读-改-写;崩溃最坏只丢半行,
 *     半行在读取时会被跳过(见 parseLines),不会连累后面所有记录。
 *
 * 为什么只留一代轮转文件:这是「最近发生了什么」的排障日志,不是审计归档 ——
 * 两代 4MB 足够覆盖一次会话史,再多就变成替用户占磁盘。
 *
 * 职责边界:本模块只碰日志文件与记录校验,不碰窗口、对话框(导出对话框在 main.cjs),
 * 也不关心日志页长什么样。
 * ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/* ---------------------------------------------------------------------------
 * 0. 契约常量(与渲染层的类型声明一一对应,改这里就要同步改那边)
 * ------------------------------------------------------------------------- */
const CURRENT_NAME = 'dfae.log';
const ROTATED_NAME = 'dfae.1.log';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;      // 2MB:超过就轮转,两代合计最坏 4MB
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const MAX_BATCH = 200;                          // 单次 append 上限:一次刷新日志不该把主进程卡住
const MAX_TAG = 32;
const MAX_MSG = 2000;
const MAX_DETAIL = 20000;
const MAX_ID = 64;
const DEFAULT_LIMIT = 1000;                     // read 默认条数
const MAX_LIMIT = 5000;                         // read 上限(再多页面也渲染不动)
const DEFAULT_TAG = '应用';                     // 没给 tag 的记录归到默认分组
const MAIN_TAG = '主进程';                      // 主进程自己产生的事件固定用这个 tag

/* ---------------------------------------------------------------------------
 * 1. 小工具
 * ------------------------------------------------------------------------- */
function errText(e) {
  return e && e.message ? e.message : String(e);
}

/** 文件体积(不存在/不是文件都按 0 算,调用方不需要再判空)。 */
function safeSize(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/* ---------------------------------------------------------------------------
 * 2. 记录校验
 * ------------------------------------------------------------------------- */
/**
 * 把任意输入收敛成一条合法记录;不合法返回 null(调用方静默丢弃)。
 *
 * 校验是「白名单裁剪 + 硬性拒绝」两段:
 *   · 白名单之外的字段直接忽略(渲染层顺手带上 stack、时间戳之类的东西很常见)——
 *     日志丢一条就少一条现场,能救则救;
 *   · 但 id/t/level/msg 这些「没有就没法显示」的字段一旦不合法就整条丢弃,
 *     否则日志页会拿到一条渲染不了的空壳记录。
 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const id = String(raw.id == null ? '' : raw.id).trim();
  if (!id || id.length > MAX_ID) return null;

  /* t 允许 Date(结构化克隆会把 Date 原样送过来);其余必须是正的有限毫秒数。
   * 0 / NaN / 字符串时间都算非法 —— 读取后的排序全靠它,错一个就会把整段历史排乱。 */
  const t = raw.t instanceof Date ? raw.t.getTime() : Number(raw.t);
  if (!Number.isFinite(t) || t <= 0 || t > 8.64e15) return null;

  const level = String(raw.level == null ? '' : raw.level).trim().toLowerCase();
  if (!LEVELS.has(level)) return null;

  /* tag 去空白后 ≤32 字;空 tag 归一到默认标签 —— 渲染层可能还没设分组就记了一条,
   * 丢掉它不如让它出现在「应用」分组里。 */
  const tag = String(raw.tag == null ? '' : raw.tag).trim();
  if (tag.length > MAX_TAG) return null;

  /* msg 按「单行」处理:即使带了换行,JSON.stringify 也会转义成 \n,JSONL 仍是一行一条;
   * 但空消息没有信息量,直接丢掉。 */
  const msg = String(raw.msg == null ? '' : raw.msg).trim();
  if (!msg || msg.length > MAX_MSG) return null;

  const out = { id, t, level, tag: tag || DEFAULT_TAG, msg };

  /* detail 可选、可多行:报错栈、请求参数这类东西放这里。 */
  if (raw.detail != null) {
    if (typeof raw.detail !== 'string' && typeof raw.detail !== 'number') return null;
    const detail = String(raw.detail);
    if (detail.length > MAX_DETAIL) return null;
    if (detail) out.detail = detail;
  }
  return out;
}

/**
 * 解析一段 JSONL。坏行(崩溃时写了半行、手工编辑留下的脏行)直接跳过:
 * 一行坏了不该让后面所有记录都读不出来。
 */
function parseLines(text, out) {
  if (!text) return;
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let raw;
    try {
      raw = JSON.parse(s);
    } catch {
      continue;
    }
    const rec = normalizeRecord(raw);
    if (rec) out.push(rec);
  }
}

/**
 * 读两代文件并合并。返回 { records: 最后 limit 条(时间升序), total: 合并后的总条数 }。
 * 先上一代、再当前文件:时间相同时靠这个顺序兜底(Array.prototype.sort 是稳定排序)。
 */
function readRecords(dir, limit) {
  const out = [];
  for (const file of [path.join(dir, ROTATED_NAME), path.join(dir, CURRENT_NAME)]) {
    try {
      parseLines(fs.readFileSync(file, 'utf8'), out);
    } catch {
      /* 文件不存在 / 读不了:当作这一代没有记录 */
    }
  }
  out.sort((a, b) => a.t - b.t);
  const total = out.length;
  return { records: total > limit ? out.slice(total - limit) : out, total };
}

/* ---------------------------------------------------------------------------
 * 3. 主进程自用的日志函数(初始化之前调用也安全)
 * ------------------------------------------------------------------------- */
/* 初始化前(createLogs 之前)的主进程事件先排队:启动初期那几条恰恰最值得看,
 * 直接丢掉会让「为什么没起来」永远查不到。队列有上限,初始化失败时也不会无限涨内存。 */
let current = null;
const pending = [];

let seq = 0;
/* 本次运行的短标识:重启后 id 不会和日志文件里的旧记录撞车(页面拿 id 当 React key)。 */
const SESSION = Date.now().toString(36);

function nextId() {
  seq += 1;
  return 'l-' + SESSION + '-' + seq;
}

/** 主进程记录:固定 tag「主进程」,id/t 自动生成。 */
function makeMainRecord(level, msg, detail) {
  try {
    return normalizeRecord({ id: nextId(), t: Date.now(), level, tag: MAIN_TAG, msg, detail });
  } catch {
    return null;
  }
}

function emit(level, msg, detail) {
  const rec = makeMainRecord(level, msg, detail);
  if (!rec) return null;
  try {
    if (current) current.append([rec]);
    else if (pending.length < MAX_BATCH) pending.push(rec);
    /* 队列满了就丢掉新的一条:初始化都失败了,再攒日志也没地方落 */
  } catch {
    /* 记日志失败绝不能影响业务,这里兜住所有意外 */
  }
  return rec;
}

function logDebug(msg, detail) { return emit('debug', msg, detail); }
function logInfo(msg, detail) { return emit('info', msg, detail); }
function logWarn(msg, detail) { return emit('warn', msg, detail); }
function logError(msg, detail) { return emit('error', msg, detail); }

/* ---------------------------------------------------------------------------
 * 4. 控制器
 * ------------------------------------------------------------------------- */
/**
 * 创建日志控制器。
 * @param {{ dir?: string, version?: string, maxBytes?: number }} opts
 *   dir:日志目录,正式启动时固定传 <userData>/logs(见 main.cjs 的 bootstrap);
 *        缺省落到系统临时目录,只是为了让单测/工具能直接 createLogs({}) 而不炸。
 *   version:应用版本号,写进 info(),日志页上要显示它。
 *   maxBytes:轮转阈值,默认 2MB;开放出来是给单测用小阈值验证轮转,正式路径不传。
 */
function createLogs(opts = {}) {
  const dir = path.resolve(String(opts.dir || path.join(os.tmpdir(), 'dfae-logs')));
  const currentFile = path.join(dir, CURRENT_NAME);
  const rotatedFile = path.join(dir, ROTATED_NAME);
  const version = String(opts.version || '');
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;

  function ensureDir() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  /** 轮转:当前文件 → 上一代(只一代,旧的直接覆盖)。 */
  function rotate() {
    try {
      try {
        fs.unlinkSync(rotatedFile);          // 先删掉上一代:Windows 上有些版本 rename 不覆盖
      } catch {
        /* 还没有上一代 */
      }
      fs.renameSync(currentFile, rotatedFile);
      return true;
    } catch {
      /* Windows 上杀软 / 索引服务可能短暂占着句柄让 rename 失败;
       * 退回复制 + 清空,至少不会让当前文件无限长大。 */
      try {
        fs.copyFileSync(currentFile, rotatedFile);
        fs.truncateSync(currentFile, 0);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * 真正写盘。所有异常在这里收敛成 { ok:false, error },调用方永远不用 try。
   *
   * 逐条拼批而不是一次性 write:一批 200 条、每条 detail 上限 20KB 时总量能到 4MB,
   * 一次性写下去就会让单个日志文件直接超过 2MB,轮转阈值形同虚设。这里在拼的过程中
   * 就按「当前文件 + 待写缓冲」估算体积,到阈值就先落盘再轮转,保证每代都不超过 maxBytes。
   */
  function appendRaw(records) {
    if (!records.length) return { ok: true, written: 0 };
    if (!ensureDir()) return { ok: false, written: 0, error: '日志目录不可写:' + dir };
    try {
      let size = safeSize(currentFile);
      let lines = [];
      let buffered = 0;
      const flush = () => {
        if (!lines.length) return;
        const chunk = Buffer.from(lines.join('\n') + '\n', 'utf8');
        fs.appendFileSync(currentFile, chunk);
        size += chunk.length;
        lines = [];
        buffered = 0;
      };
      for (const rec of records) {
        const line = JSON.stringify(rec);
        const bytes = Buffer.byteLength(line, 'utf8') + 1;   // +1 = 换行符
        if (size > 0 && size + buffered + bytes > maxBytes) {
          flush();
          /* 轮转失败(句柄被占)时不要陷入「每条都试一次」,继续往当前文件追加即可,
           * 下一次写盘还会再试 —— 日志宁可大一点,也不能丢。 */
          if (rotate()) size = 0;
        }
        lines.push(line);
        buffered += bytes;
        if (buffered >= 256 * 1024) flush();                 // 顺手限制单次缓冲,避免 4MB 字符串常驻
      }
      flush();
      return { ok: true, written: records.length };
    } catch (e) {
      /* 写盘失败不能抛给业务:页面只是记了条日志,不该因此让整个操作报错 */
      return { ok: false, written: 0, error: errText(e) };
    }
  }

  /** 追加一批记录。非法记录静默丢弃;超过 200 条的部分也算丢弃。 */
  function append(records) {
    try {
      const list = Array.isArray(records) ? records : [records];
      const valid = [];
      for (const raw of list.slice(0, MAX_BATCH)) {
        const rec = normalizeRecord(raw);
        if (rec) valid.push(rec);
      }
      const dropped = list.length - valid.length;   // 非法 + 超量一起统计
      const res = appendRaw(valid);
      if (res.ok && dropped > 0) res.dropped = dropped;
      return res;
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  /** 读最近 limit 条(时间升序)。limit 默认 1000,夹在 1..5000。 */
  function read(optsIn = {}) {
    try {
      let limit = Math.floor(Number(optsIn && optsIn.limit));
      if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
      if (limit > MAX_LIMIT) limit = MAX_LIMIT;
      const { records, total } = readRecords(dir, limit);
      return { ok: true, records, total, dir, file: currentFile, rotated: rotatedFile };
    } catch (e) {
      /* 读日志失败对页面来说等同于「还没有日志」,不要让它变成一块报错 */
      return { ok: false, records: [], total: 0, dir, file: currentFile, error: errText(e) };
    }
  }

  /** 清空两代文件。文件本来就不存在不算失败(幂等)。 */
  function clear() {
    const errors = [];
    for (const file of [currentFile, rotatedFile]) {
      try {
        fs.unlinkSync(file);
      } catch (e) {
        if (e && e.code === 'ENOENT') continue;
        errors.push(errText(e));
      }
    }
    return errors.length ? { ok: false, error: errors.join(';') } : { ok: true };
  }

  /** 日志目录 / 文件 / 体积,日志页顶栏用来显示「日志存哪儿了」。 */
  function info() {
    return {
      dir,
      file: currentFile,
      rotated: rotatedFile,
      size: safeSize(currentFile),
      rotatedSize: safeSize(rotatedFile),
      maxBytes,
      version,
    };
  }

  /**
   * 写一份导出文件。路径**必须**由主进程的保存对话框提供(main.cjs 只把
   * 用户亲手选中的那个路径传进来),本模块不接受「按名字写任意目录」。
   */
  function writeText(filePath, text) {
    try {
      const raw = String(filePath || '').trim();
      if (!raw) return { ok: false, error: '没有选择保存位置' };
      const target = path.resolve(raw);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(text == null ? '' : text), 'utf8');
      return { ok: true, path: target, size: safeSize(target) };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  const controller = {
    dir: () => dir,
    file: () => currentFile,
    rotatedFile: () => rotatedFile,
    info,
    append,
    read,
    clear,
    writeText,
    /** 主进程内部记录(固定 tag「主进程」)。 */
    log(level, msg, detail) {
      const rec = makeMainRecord(level, msg, detail);
      if (rec) append([rec]);
      return rec;
    },
  };
  controller.logDebug = (msg, detail) => controller.log('debug', msg, detail);
  controller.logInfo = (msg, detail) => controller.log('info', msg, detail);
  controller.logWarn = (msg, detail) => controller.log('warn', msg, detail);
  controller.logError = (msg, detail) => controller.log('error', msg, detail);

  ensureDir();                                  // 提前建好目录:日志页「打开目录」不会扑空
  current = controller;                         // 模块级 logInfo/logWarn/logError 指向最新的控制器
  if (pending.length) append(pending.splice(0, pending.length));
  return controller;
}

module.exports = {
  createLogs,
  logDebug,
  logInfo,
  logWarn,
  logError,
  /* 上限常量导出给单测/工具用,避免「界面提示的上限」和「实现里的上限」两处写死 */
  LOG_LIMITS: {
    MAX_BATCH,
    MAX_TAG,
    MAX_MSG,
    MAX_DETAIL,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    DEFAULT_MAX_BYTES,
  },
};
