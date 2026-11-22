'use strict';
/* ============================================================================
 * 三角洲行动 cooked uasset / uexp 解析器（UI 图标提取专用，只读）
 * ---------------------------------------------------------------------------
 * 三角洲客户端是 UE 4.27 改版 + 自定义打包，包体格式与标准 cooked 有几处实测差异
 * （全部在本机 pak 上逆向验证过，改这里之前先跑 tools/check-icons-parser.mjs）：
 *
 *  1) 摘要区（FPackageFileSummary）是自定义变体：
 *     magic(0x9E2A83C1) + LegacyFileVersion(-4613, 自定义标记) + UE3Ver(864) +
 *     FileVersionUE4(522) + Licensee + 自定义版本表(每条 20 字节, 无 FriendlyName) +
 *     TotalHeaderSize + FolderName + PackageFlags + NameCount/NameOffset。
 *     名字表是**排序去重**过的，且包导入的 ObjectName 直接存 /Game/ 全路径
 *     （标准包只存短名）—— 这让"sprite -> 图集"的解析不需要查外部索引。
 *  2) 属性流是**纯连续布局**（无对齐填充），每个 tag：
 *        Name FName(8B) + Type FName(8B) + Size i32 + ArrayIdx i32 + [类型附加头] + 值
 *     类型附加头（实测）：
 *        StructProperty : StructType FName(8B) + 1B 标志 + 16B GUID + 值(Size 字节)
 *        ObjectProperty : 1B 标志 + 值(Size 字节，FPackageIndex, 负数=导入表序号)
 *        BoolProperty   : 值 = 2 字节（首字节 0/1）
 *        ByteProperty   : 枚举名 FName(8B) + 1 字节 + 枚举值名 FName(8B)
 *  3) 名字表每项 = FString + 4 字节哈希；导入表每条 28 字节 =
 *        包名 FName + 类名 FName + Outer i32 + 对象名 FName。
 *
 * 只暴露提取 PaperSprite 三件套（BakedSourceUV / BakedSourceDimension /
 * BakedSourceTexture）所需的最小能力；解析失败一律返回 { ok:false, error }，
 * 不抛异常 —— 索引构建要把失败记进统计而不是中断整包扫描。
 * ========================================================================== */

const MAGIC = 0x9E2A83C1;

class SpriteParseError extends Error {}

/** UE FString：i32 长度（含结尾 0），负数 = UTF-16。 */
function readFString(buf, pos) {
  if (pos + 4 > buf.length) throw new SpriteParseError('FString 越界 @' + pos);
  const len = buf.readInt32LE(pos);
  pos += 4;
  if (len === 0) return { value: '', pos };
  if (len > 0) {
    if (len > 1024 || pos + len > buf.length) throw new SpriteParseError('FString 长度非法 ' + len + ' @' + pos);
    if (buf[pos + len - 1] !== 0) throw new SpriteParseError('FString 未以 0 结尾 @' + pos);
    return { value: buf.toString('latin1', pos, pos + len - 1), pos: pos + len };
  }
  const n = -len;
  if (n > 512 || pos + n * 2 > buf.length) throw new SpriteParseError('FString(UTF16) 长度非法 ' + n + ' @' + pos);
  return { value: buf.toString('utf16le', pos, pos + n * 2 - 2), pos: pos + n * 2 };
}

function isPlausibleText(s) {
  if (!s) return true; // 空串合法
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 && c !== 9) return false;
    if (c === 0xFFFD) return false;
  }
  return true;
}

/**
 * 解析摘要区，返回 { folderName, flags, nameCount, nameOffset, fileVersionUE4 }。
 * 摘要中段字段顺序没 100% 固定（不同资产可能带 LocalizationId），所以对
 * NameCount/NameOffset 的位置做小幅位移试探，用"名字表能完整解出来"作判据。
 */
function parseSummary(buf) {
  if (buf.length < 64) throw new SpriteParseError('uasset 太小');
  if (buf.readUInt32LE(0) !== MAGIC) throw new SpriteParseError('魔数不是 0x9E2A83C1');
  const fileVersionUE4 = buf.readInt32LE(12);
  let p = 16;
  const licensee = buf.readInt32LE(p); p += 4;
  if (licensee < 0 || licensee > 0xFFFF) throw new SpriteParseError('LicenseeVersion 异常 ' + licensee);
  const customCount = buf.readInt32LE(p); p += 4;
  if (customCount < 0 || customCount > 64) throw new SpriteParseError('CustomVersion 数量异常 ' + customCount);
  p += customCount * 20;
  const totalHeaderSize = buf.readInt32LE(p); p += 4;
  if (totalHeaderSize <= 64 || totalHeaderSize > buf.length) throw new SpriteParseError('TotalHeaderSize 异常 ' + totalHeaderSize);
  const folder = readFString(buf, p); p = folder.pos;
  if (!isPlausibleText(folder.value)) throw new SpriteParseError('FolderName 不像文本');

  const lastError = [];
  for (let shift = 0; shift <= 8; shift += 4) {
    const q = p + shift;
    try {
      const flags = buf.readUInt32LE(q);
      const nameCount = buf.readInt32LE(q + 4);
      const nameOffset = buf.readInt32LE(q + 8);
      if (nameCount <= 0 || nameCount > 200000) throw new SpriteParseError('NameCount 越界 ' + nameCount);
      if (nameOffset < 64 || nameOffset >= totalHeaderSize) throw new SpriteParseError('NameOffset 越界 ' + nameOffset);
      // 名字表必须真的能解出来，才算命中
      const names = parseNames(buf, nameCount, nameOffset);
      if (!names.ok) throw new SpriteParseError(names.error);
      return { folderName: folder.value, flags, nameCount, nameOffset, totalHeaderSize, fileVersionUE4 };
    } catch (e) {
      lastError.push(e.message);
    }
  }
  throw new SpriteParseError('摘要区解析失败: ' + lastError.join(' / '));
}

/** 名字表：count × (FString + 4 字节哈希)。 */
function parseNames(buf, count, offset) {
  const names = new Array(count);
  let p = offset;
  for (let i = 0; i < count; i++) {
    let s;
    try { s = readFString(buf, p); } catch (e) { return { ok: false, error: '名字[' + i + '] ' + e.message }; }
    p = s.pos + 4; // 4 字节哈希
    if (p > buf.length) return { ok: false, error: '名字表越界 @' + i };
    if (!isPlausibleText(s.value)) return { ok: false, error: '名字[' + i + '] 不像文本: ' + JSON.stringify(s.value.slice(0, 24)) };
    names[i] = s.value;
  }
  return { ok: true, names, end: p };
}

/**
 * 导入表：紧跟名字表，28 字节/条。
 * [包名 FName][类名 FName][Outer i32][对象名 FName]，FName = (索引 i32, 编号 i32)。
 * 遇到第一条不像导入的记录就停（后面是导出表）。
 */
function parseImports(buf, start, names) {
  const imports = [];
  let p = start;
  while (p + 28 <= buf.length) {
    const pkgIdx = buf.readInt32LE(p);
    const pkgNum = buf.readInt32LE(p + 4);
    const clsIdx = buf.readInt32LE(p + 8);
    const clsNum = buf.readInt32LE(p + 12);
    const outer = buf.readInt32LE(p + 16);
    const objIdx = buf.readInt32LE(p + 20);
    const objNum = buf.readInt32LE(p + 24);
    const idxOk = (i) => i >= 0 && i < names.length;
    const numOk = (n) => n >= 0 && n <= 64;
    // Outer 可以是前向引用(比如类对象的包导入排在本条之后),只做量级校验
    const outerOk = (o) => o === 0 || (o < 0 && -o - 1 <= 4096);
    if (!idxOk(pkgIdx) || !idxOk(clsIdx) || !idxOk(objIdx) || !numOk(pkgNum) || !numOk(clsNum) || !numOk(objNum) || !outerOk(outer)) break;
    imports.push({ pkg: names[pkgIdx], cls: names[clsIdx], outer, obj: names[objIdx] });
    p += 28;
    if (imports.length > 4096) break;
  }
  return { imports, end: p };
}

/**
 * 沿 Outer 链解析一个导入的完整对象路径。
 * 本作包导入的 ObjectName 就是 /Game/ 全路径，直接取；拿不到就拼短名。
 * @returns {{ path: string, obj: string, cls: string }} path 形如 /Game/UI/UIAtlas/...
 */
function resolveImportPath(imports, ref) {
  if (ref >= 0) throw new SpriteParseError('只支持导入引用(负数), 得到 ' + ref);
  const idx = -ref - 1;
  const entry = imports[idx];
  if (!entry) throw new SpriteParseError('导入序号越界 ' + ref);
  let cur = entry;
  const chain = [entry];
  const guard = 64;
  for (let i = 0; i < guard && cur.outer < 0; i++) {
    const up = imports[-cur.outer - 1];
    if (!up) break;
    chain.push(up);
    cur = up;
  }
  // 链上第一个 /Game/ 开头的名字 = 包全路径（本作特有）
  for (const e of chain) {
    if (e.obj && e.obj.startsWith('/Game/')) {
      return { path: e.obj, obj: entry.obj, cls: entry.cls };
    }
  }
  // 兜底：短名拼接（标准包形态），拼出来的是 /Script/xxx 风格，不理想但可作检索键
  const parts = chain.map((e) => e.obj).reverse();
  return { path: parts.join('.'), obj: entry.obj, cls: entry.cls };
}

/**
 * 走查 uexp 属性流。返回 { ok, props, end } —— props 是 Map<属性名, 值>。
 * 未知属性类型会**优雅停下**（返回已解析的部分），调用方用 stop 提前收工。
 */
function walkProperties(uexp, names, opts) {
  const props = new Map();
  const noneIdx = names.indexOf('None');
  const nameOf = (idx, num) => names[idx] + (num ? '_' + num : '');
  let pos = 0;
  let guard = 0;
  const fail = (why) => ({ ok: false, props, end: pos, error: why });
  while (pos + 24 <= uexp.length) {
    if (++guard > 512) return fail('属性条数超限');
    const nameIdx = uexp.readInt32LE(pos);
    const nameNum = uexp.readInt32LE(pos + 4);
    if (nameIdx === noneIdx && nameNum === 0) return { ok: true, props, end: pos + 8 };
    if (nameIdx < 0 || nameIdx >= names.length || nameNum !== 0) return fail('属性名索引异常 ' + nameIdx + ',' + nameNum + ' @' + pos);
    const typeIdx = uexp.readInt32LE(pos + 8);
    const typeNum = uexp.readInt32LE(pos + 12);
    if (typeIdx < 0 || typeIdx >= names.length || typeNum !== 0) return fail('属性类型索引异常 @' + pos);
    const size = uexp.readInt32LE(pos + 16);
    if (size < 0 || size > 0x4000000) return fail('属性 Size 异常 ' + size + ' @' + pos);
    const type = names[typeIdx];
    let p = pos + 24;
    let value = null;
    if (type === 'StructProperty') {
      const stIdx = uexp.readInt32LE(p);
      const stNum = uexp.readInt32LE(p + 4);
      if (stIdx < 0 || stIdx >= names.length || stNum !== 0) return fail('StructType 索引异常 @' + p);
      const structType = names[stIdx];
      p += 8;
      p += 17; // 1 字节标志 + 16 字节 GUID（本作固定跟在 StructType 后面）
      if (p + size > uexp.length) return fail('StructProperty 值越界 @' + p + ' size=' + size);
      if (structType === 'Vector2D' && size >= 8) {
        value = { x: uexp.readFloatLE(p), y: uexp.readFloatLE(p + 4) };
      } else if (structType === 'IntPoint' && size >= 8) {
        value = { x: uexp.readInt32LE(p), y: uexp.readInt32LE(p + 4) };
      } else if (structType === 'Vector4' && size >= 16) {
        value = [uexp.readFloatLE(p), uexp.readFloatLE(p + 4), uexp.readFloatLE(p + 8), uexp.readFloatLE(p + 12)];
      } else if (size <= 64) {
        value = uexp.subarray(p, p + size);
      }
      p += size;
    } else if (type === 'ObjectProperty') {
      // 与 StructProperty 同款:值前有 1 字节标志(实测恒 0,置 1 时理论上有 16B GUID)
      if (p + 1 > uexp.length) return fail('ObjectProperty 标志越界 @' + p);
      const objFlag = uexp[p];
      p += 1;
      if (objFlag !== 0) return fail('ObjectProperty 带未知标志 ' + objFlag + ' @' + p);
      if (size < 4 || p + 4 > uexp.length) return fail('ObjectProperty 值越界 @' + p);
      value = uexp.readInt32LE(p);
      p += size;
    } else if (type === 'BoolProperty') {
      if (p + 2 > uexp.length) return fail('BoolProperty 值越界 @' + p);
      value = uexp[p] !== 0;
      p += 2;
    } else if (type === 'ByteProperty') {
      const enIdx = uexp.readInt32LE(p);
      const enNum = uexp.readInt32LE(p + 4);
      if (enIdx < 0 || enIdx >= names.length || enNum !== 0) return fail('枚举名索引异常 @' + p);
      const enumName = names[enIdx];
      p += 8;
      if (p + 1 > uexp.length) return fail('ByteProperty 值越界 @' + p);
      const byteVal = uexp[p];
      p += 1;
      const vnIdx = uexp.readInt32LE(p);
      const vnNum = uexp.readInt32LE(p + 4);
      if (vnIdx < 0 || vnIdx >= names.length || vnNum !== 0) return fail('枚举值名索引异常 @' + p);
      const valueName = names[vnIdx];
      p += 8;
      value = { enum: enumName, byte: byteVal, name: valueName };
    } else if (type === 'FloatProperty') {
      if (size < 4 || p + 4 > uexp.length) return fail('FloatProperty 值越界 @' + p);
      value = uexp.readFloatLE(p);
      p += size;
    } else if (type === 'IntProperty') {
      if (size < 4 || p + 4 > uexp.length) return fail('IntProperty 值越界 @' + p);
      value = uexp.readInt32LE(p);
      p += size;
    } else if (type === 'ArrayProperty') {
      // 值内部结构按 Size 整段跳过（图标提取用不到数组内容）
      if (p + size > uexp.length) return fail('ArrayProperty 值越界 @' + p + ' size=' + size);
      p += size;
    } else {
      return fail('未知属性类型 ' + type + ' @' + pos);
    }
    props.set(nameOf(nameIdx, nameNum), value);
    pos = p;
    if (opts && opts.stop && opts.stop(props)) return { ok: true, props, end: pos, stopped: true };
  }
  return fail('uexp 属性区走查到头仍未终止');
}

/**
 * 从一份 PaperSprite 的 uasset/uexp 提取图标三件套。
 * @returns {{ok:true, uv:{x,y}, dim:{w,h}, atlas:{path,obj,cls}, hd:boolean, uexpEnd:number}
 *          |{ok:false, error:string}}
 */
function extractSprite(uasset, uexp) {
  try {
    const summary = parseSummary(uasset);
    const nt = parseNames(uasset, summary.nameCount, summary.nameOffset);
    if (!nt.ok) return { ok: false, error: nt.error };
    const names = nt.names;
    const im = parseImports(uasset, nt.end, names);
    const walk = walkProperties(uexp, names, {
      stop: (props) => props.has('BakedSourceUV') && props.has('BakedSourceDimension') && props.has('BakedSourceTexture'),
    });
    const uv = walk.props.get('BakedSourceUV');
    const dim = walk.props.get('BakedSourceDimension');
    const texRef = walk.props.get('BakedSourceTexture');
    if (!uv || !dim || typeof texRef !== 'number') {
      return { ok: false, error: walk.error || '缺少 BakedSource 三件套' };
    }
    if (!Number.isFinite(uv.x) || !Number.isFinite(uv.y) || !Number.isFinite(dim.w ?? dim.x)) {
      return { ok: false, error: 'UV/尺寸不是有效浮点' };
    }
    const w = dim.w ?? dim.x;
    const h = dim.h ?? dim.y;
    if (!(w > 0 && h > 0 && w <= 2048 && h <= 2048)) {
      return { ok: false, error: '图标尺寸异常 ' + w + 'x' + h };
    }
    let atlas = null;
    try {
      atlas = resolveImportPath(im.imports, texRef);
    } catch (e) {
      return { ok: false, error: '图集引用解析失败: ' + e.message };
    }
    const atlasPath = atlas.path || '';
    const hd = /\/UI_HD\//.test(atlasPath) || /UI_HD\//.test(atlasPath.replace(/^\/Game\//, ''));
    return {
      ok: true,
      uv: { x: uv.x, y: uv.y },
      dim: { w: Math.round(w), h: Math.round(h) },
      atlas: { path: atlasPath, obj: atlas.obj, cls: atlas.cls },
      hd,
      uexpEnd: walk.end,
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { parseSummary, parseNames, parseImports, walkProperties, extractSprite, resolveImportPath, SpriteParseError, MAGIC };
