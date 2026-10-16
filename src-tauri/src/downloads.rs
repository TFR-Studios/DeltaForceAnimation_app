/* ============================================================================
 * 下载列表 / 下载历史(对应 electron/downloads.cjs)
 *
 * 三件事,与 Electron 版逐条对齐:
 *   1) 落盘位置固定 —— 自动保存(默认)统一落到系统「下载」文件夹下的
 *      「三角洲行动动画编辑器」子目录,重名自动加 (1)(2) 后缀,绝不覆盖;
 *   2) 下载历史(软件删掉/搬走都还在)—— 清单是 <应用数据目录>/download-history.json;
 *   3) 列表与磁盘对账 —— 每次 list() 重建缺失清单、按「相对路径 / 文件名+体积+帧数」
 *      三级手段重新定位被挪走的文件;找不到只标 missing,条目保留。
 *
 * 返回给前端的 JSON 字段名与 electron/downloads.cjs 的 publicEntry 完全一致
 * (id/name/path/size/format/at/frames/source/missing),以及 list() 的
 * { dir, historyFile, promptOnSave, entries, total, missing } —— 前端渲染代码一个字段都不用改。
 * ========================================================================== */
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/* 与 electron/downloads.cjs 的常量逐一对应 */
pub const DOWNLOADS_DIR_NAME: &str = "downloads";
pub const APP_FOLDER_NAME: &str = "三角洲行动动画编辑器";
pub const HISTORY_FILE_NAME: &str = "download-history.json";
const HISTORY_VERSION: u32 = 1;

/* ---------------------------------------------------------------------------
 * 数据结构(字段名即 JSON 字段名,不许随意改)
 * ------------------------------------------------------------------------- */

/** 磁盘上真实的一条历史记录(对应 downloads.cjs 的 entry)。 */
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HistoryEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub rel: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub format: String,
    /** 显示用的本地时间 'YYYY-MM-DD HH:MM:SS' */
    #[serde(default)]
    pub at: String,
    /** ISO 时间,排序用 */
    #[serde(default, rename = "createdAt")]
    pub created_at: String,
    #[serde(default)]
    pub frames: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested: Option<String>,
    #[serde(default)]
    pub source: String,
    /* 以下两个字段只在进程内有效,不写进清单文件 */
    #[serde(default, skip)]
    pub resolved_path: String,
    #[serde(default, skip)]
    pub missing: bool,
}

/** 返回给前端的一条记录(对应 downloads.cjs 的 publicEntry)。 */
#[derive(Debug, Clone, Serialize)]
pub struct PublicEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub format: String,
    pub at: String,
    pub frames: Option<u64>,
    pub source: String,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SaveResult {
    /** 'auto' = 已落盘并登记;'prompt' = 用户要求每次询问,由页面退回原生另存为 */
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<PublicEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListResult {
    pub dir: String,
    #[serde(rename = "historyFile")]
    pub history_file: String,
    #[serde(rename = "promptOnSave")]
    pub prompt_on_save: bool,
    pub entries: Vec<PublicEntry>,
    pub total: usize,
    pub missing: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoveResult {
    pub ok: bool,
}

/* ---------------------------------------------------------------------------
 * 小工具(逐条移植 downloads.cjs 的同名函数)
 * ------------------------------------------------------------------------- */

/** 把任意输入收敛成一个合法、可读的文件名(保留中文,去掉路径分隔符与非法字符)。 */
pub fn sanitize_filename(name: &str, fallback: &str) -> String {
    let mut base = name.trim().to_string();
    if base.is_empty() {
        base = fallback.to_string();
    }
    // 只取最后一段:外部传 './a/b.mp4' 或 'C:\\x\\y.mp4' 都不能变成目录穿越
    if let Some(last) = base.rsplit(['/', '\\']).next() {
        base = last.to_string();
    }
    let mut cleaned = String::with_capacity(base.len());
    for ch in base.chars() {
        let bad = matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            || (ch as u32) < 0x20;
        cleaned.push(if bad { '_' } else { ch });
    }
    base = cleaned;
    // 结尾的点/空格会被 Windows 静默吞掉,统一挪成下划线,避免「显示的名字」与「盘上的名字」不一致
    while base.ends_with('.') || base.ends_with(' ') {
        base.pop();
        base.push('_');
    }
    // 开头的点会让文件在资源管理器里默认隐藏
    if base.starts_with('.') {
        while base.starts_with('.') {
            base.replace_range(0..1, "_");
        }
    }
    // Windows 设备名:con.mp4 同样打不开
    let stem = Path::new(&base)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        base = format!("_{base}");
    }
    if base.chars().count() > 120 {
        let ext = Path::new(&base)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{}", e.chars().take(12).collect::<String>()))
            .unwrap_or_default();
        let keep = 120usize.saturating_sub(ext.chars().count());
        base = format!("{}{}", base.chars().take(keep).collect::<String>(), ext);
    }
    if base.is_empty() {
        fallback.to_string()
    } else {
        base
    }
}

/** 在 dir 里给 filename 找一个不重名的落点:name.mp4 → name (1).mp4 → name (2).mp4 … */
pub fn unique_path(dir: &Path, filename: &str, taken: &HashSet<String>) -> PathBuf {
    let safe = sanitize_filename(filename, "animation");
    let ext = Path::new(&safe)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let stem = safe[..safe.len() - ext.len()].to_string();
    let occupied: HashSet<String> = taken.iter().map(|t| t.to_lowercase()).collect();
    let mut candidate = dir.join(&safe);
    let mut n = 0u32;
    loop {
        let key = candidate
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !occupied.contains(&key) && !candidate.exists() {
            break;
        }
        n += 1;
        candidate = dir.join(format!("{stem} ({n}){ext}"));
        if n > 999 {
            break; // 极端情况兜底,别在这里死循环
        }
    }
    candidate
}

fn file_size(p: &Path) -> u64 {
    match fs::metadata(p) {
        Ok(m) if m.is_file() => m.len(),
        _ => 0,
    }
}

fn format_of(file: &str) -> String {
    Path::new(file)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_uppercase()
}

/** 本地时间 'YYYY-MM-DD HH:MM:SS'(历史列表直接显示,不走系统区域设置)。 */
fn stamp(ts: SystemTime) -> String {
    let (y, mo, d, h, mi, s) = local_parts(unix_secs(ts));
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}

fn stamp_now() -> String {
    stamp(SystemTime::now())
}

fn iso_of(ts: SystemTime) -> String {
    let (y, mo, d, h, mi, s) = local_parts(unix_secs(ts));
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}")
}

fn iso_now() -> String {
    iso_of(SystemTime::now())
}

fn unix_secs(ts: SystemTime) -> i64 {
    ts.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/**
 * Unix 秒 → 本地时间的年月日时分秒。
 * 自己算而不用 chrono:这里只需要"列表能显示、能排序",不涉及时区数据库/夏令时的精确边界,
 * 固定按 UTC+8 换算(本项目只面向中文 Windows 用户),少一个体积不小的依赖。
 */
fn local_parts(unix_secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let local = unix_secs + 8 * 3600;
    let days = local.div_euclid(86_400);
    let rem = local.rem_euclid(86_400);
    let (h, mi, s) = (
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    );
    // Howard Hinnant 的 civil_from_days
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d, h, mi, s)
}

/** 目录是否可写。用真实写入探测,而不是看权限位(Windows 上权限位不可靠)。 */
fn can_write_dir(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".dfae-write-test");
    match fs::write(&probe, "ok") {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/**
 * 数一份文件里的帧数,用来区分"同一个动画的重复导出"(一模一样的动画体积与帧数都相同)。
 * 只读文件头:AVI 读 RIFF/avih.dwTotalFrames,MP4 读 stts 采样总数。读不出来返回 None,
 * 此时退化成"同名同体积"判定,不会误判 —— 与 electron/downloads.cjs 的 readFrameCount 同逻辑。
 */
fn read_frame_count(file: &Path) -> Option<u64> {
    let mut f = fs::File::open(file).ok()?;
    let size = f.metadata().ok()?.len();
    if size < 32 {
        return None;
    }
    let n = std::cmp::min(65_536, size) as usize;
    let mut head = vec![0u8; n];
    let mut read = 0usize;
    while read < n {
        match f.read(&mut head[read..]) {
            Ok(0) => break,
            Ok(k) => read += k,
            Err(_) => return None,
        }
    }
    head.truncate(read);
    /* AVI:RIFF 容器 + avih 块。dwTotalFrames 是 avih_data 的第 2 个字段,整个块内偏移 12
     * (块头 4 字节 + dwSize 4 字节 + dwMicroSecPerFrame 4 字节),与 electron/downloads.cjs 的
     * readFrameCount 读的位置完全一致。 */
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"AVI " {
        if let Some(idx) = find_sub(&head, b"avih") {
            if idx + 16 <= head.len() {
                let frames = u32::from_le_bytes([
                    head[idx + 12],
                    head[idx + 13],
                    head[idx + 14],
                    head[idx + 15],
                ]);
                return Some(frames as u64);
            }
        }
        return None;
    }
    /* MP4:stts 盒的 sample count 在盒内偏移 12(盒头 8 + version/flags 4)。 */
    if head.len() >= 8 && &head[4..8] == b"ftyp" {
        if let Some(idx) = find_sub(&head, b"stts") {
            if idx + 16 <= head.len() {
                let samples = u32::from_be_bytes([
                    head[idx + 12],
                    head[idx + 13],
                    head[idx + 14],
                    head[idx + 15],
                ]);
                return Some(samples as u64);
            }
        }
        return None;
    }
    None
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/** Windows 下路径比较必须忽略大小写:同一个文件经不同写法拿到,大小写会不一样。 */
fn normalize_key(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").to_ascii_lowercase()
}

/* ---------------------------------------------------------------------------
 * 清单读写
 * ------------------------------------------------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct History {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    entries: HashMap<String, HistoryEntry>,
    #[serde(default, rename = "downloadsDir")]
    downloads_dir: String,
    #[serde(default, rename = "promptOnSave")]
    prompt_on_save: bool,
}

/** 读清单。任何损坏/缺失都回落成空清单 —— 历史不该因为一个坏字节让应用起不来。 */
fn read_history(file: &Path) -> History {
    match fs::read_to_string(file) {
        Ok(raw) => match serde_json::from_str::<History>(&raw) {
            Ok(mut h) => {
                h.version = HISTORY_VERSION;
                h
            }
            Err(_) => History {
                version: HISTORY_VERSION,
                ..Default::default()
            },
        },
        Err(_) => History {
            version: HISTORY_VERSION,
            ..Default::default()
        },
    }
}

/**
 * 写清单:先写临时文件再 rename(与 Electron 版同一策略)。
 * 直接覆盖写有风险 —— 断电/崩溃会留下半截 JSON,下一次启动历史就整体丢了。
 * rename 在同一分区上是原子的,最坏情况也只是丢掉最后一次记录。
 */
fn write_history(file: &Path, history: &History) -> bool {
    let tmp = PathBuf::from(format!("{}.tmp", file.display()));
    if let Some(parent) = file.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    let payload = match serde_json::to_string_pretty(history) {
        Ok(p) => p,
        Err(_) => return false,
    };
    if fs::write(&tmp, payload).is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    if fs::rename(&tmp, file).is_ok() {
        true
    } else {
        let _ = fs::remove_file(&tmp);
        false
    }
}

/* ---------------------------------------------------------------------------
 * 目录解析
 * ------------------------------------------------------------------------- */

/**
 * 下载目录解析(与 ensureDownloadsDir 同优先级):
 *   1) 显式指定的目录(环境变量 DFAE_DOWNLOADS_DIR,便于自检/自定义存放);
 *   2) 清单里记着的目录 —— 用户上次的落点就该一直用下去,否则文件会被拆到两个目录里;
 *   3) 系统「下载」文件夹下的应用子目录(与 Electron 完全一致);
 *   4) 退回应用数据目录下的 downloads/(取不到系统下载文件夹时的兜底);
 *   5) 再退回软件目录旁的 downloads/(老位置)。
 */
fn ensure_downloads_dir(
    requested: &str,
    is_explicit: bool,
    downloads_home: Option<PathBuf>,
    user_data_dir: &Path,
    app_dir: &Path,
) -> PathBuf {
    if is_explicit && !requested.is_empty() {
        return PathBuf::from(requested);
    }
    if !requested.is_empty() {
        let p = PathBuf::from(requested);
        if p.exists() && can_write_dir(&p) {
            return p;
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = downloads_home {
        candidates.push(home.join(APP_FOLDER_NAME));
    }
    candidates.push(user_data_dir.join(DOWNLOADS_DIR_NAME));
    candidates.push(app_dir.join(DOWNLOADS_DIR_NAME));
    for c in &candidates {
        if can_write_dir(c) {
            return c.clone();
        }
    }
    candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| user_data_dir.join(DOWNLOADS_DIR_NAME))
}

/* ---------------------------------------------------------------------------
 * 控制器(对应 downloads.cjs 的 createDownloads)
 * ------------------------------------------------------------------------- */

pub struct Manager {
    history_file: PathBuf,
    dir: PathBuf,
    app_dir: PathBuf,
    history: Mutex<History>,
}

impl Manager {
    /**
     * user_data_dir  = 应用数据目录(清单放这里,与软件目录无关);
     * app_dir        = 软件目录(兜底候选目录 + deep 搜索根);
     * downloads_home = 系统「下载」文件夹;
     * explicit_dir   = 显式指定的导出目录(可空,环境变量 DFAE_DOWNLOADS_DIR 也认)。
     */
    pub fn new(
        user_data_dir: PathBuf,
        downloads_home: Option<PathBuf>,
        app_dir: PathBuf,
        explicit_dir: Option<String>,
    ) -> Self {
        let history_file = user_data_dir.join(HISTORY_FILE_NAME);
        let mut history = read_history(&history_file);
        let env_dir = std::env::var("DFAE_DOWNLOADS_DIR")
            .ok()
            .filter(|s| !s.trim().is_empty());
        let explicit = explicit_dir.filter(|s| !s.trim().is_empty()).or(env_dir);
        let is_explicit = explicit.is_some();
        let wanted = explicit.unwrap_or_else(|| history.downloads_dir.clone());
        let dir = ensure_downloads_dir(
            &wanted,
            is_explicit,
            downloads_home,
            &user_data_dir,
            &app_dir,
        );
        let _ = fs::create_dir_all(&dir);
        history.downloads_dir = dir.to_string_lossy().to_string();
        history.version = HISTORY_VERSION;
        write_history(&history_file, &history);
        let manager = Manager {
            history_file,
            dir,
            app_dir,
            history: Mutex::new(history),
        };
        /* 首次使用时把 downloads/ 里已有的视频补进列表(历史空白也不会「什么都没看到」),
         * 并把清单里的 downloadsDir 落成当前目录。 */
        {
            let mut h = manager.history.lock().unwrap();
            if manager.import_from_scan(&mut h) > 0 {
                write_history(&manager.history_file, &h);
            }
        }
        manager
    }

    pub fn dir(&self) -> String {
        self.dir.to_string_lossy().to_string()
    }

    pub fn history_file(&self) -> String {
        self.history_file.to_string_lossy().to_string()
    }

    pub fn get_prompt_on_save(&self) -> bool {
        self.history.lock().unwrap().prompt_on_save
    }

    pub fn set_prompt_on_save(&self, on: bool) -> bool {
        let mut h = self.history.lock().unwrap();
        h.prompt_on_save = on;
        write_history(&self.history_file, &h);
        h.prompt_on_save
    }

    /** 新记录 id:与 Electron 版同构('f' + 时间戳 + 随机后缀),绝不重复。 */
    fn new_id() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(1);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let micros = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_micros() as u64)
            .unwrap_or(0);
        // 与 seq 混合后取低 32 位:同一毫秒内连续导出也不会撞 id
        let rnd = micros
            .wrapping_mul(2_654_435_761)
            .wrapping_add(seq.wrapping_mul(40_503));
        format!("f{:x}{:06x}", micros & 0xffff_ffff, rnd & 0xff_ffff)
    }

    fn public_entry(e: &HistoryEntry) -> PublicEntry {
        PublicEntry {
            id: e.id.clone(),
            name: e.name.clone(),
            path: if !e.resolved_path.is_empty() {
                e.resolved_path.clone()
            } else {
                e.path.clone()
            },
            size: e.size,
            format: e.format.clone(),
            at: e.at.clone(),
            frames: e.frames,
            source: if e.source.is_empty() {
                "export".to_string()
            } else {
                e.source.clone()
            },
            missing: e.missing,
        }
    }

    /**
     * 渲染进程把导出字节流传过来落盘(桌面端导出走这条路)。
     * 用户关掉「自动保存」时返回 { mode: 'prompt' },由页面退回 <a download> 走原生另存为。
     */
    pub fn save_bytes(&self, data: &[u8], filename: &str) -> std::io::Result<SaveResult> {
        if self.get_prompt_on_save() {
            return Ok(SaveResult {
                mode: "prompt".into(),
                path: None,
                name: None,
                entry: None,
            });
        }
        let target = unique_path(&self.dir, filename, &HashSet::new());
        /* 先写 .part 再改名:导出的视频动辄几百 MB,中途失败不能留下一个「看起来正常但播不动」的
         * 半截文件混进下载列表。改名在同一分区上是原子的。 */
        let tmp = PathBuf::from(format!("{}.part", target.display()));
        if let Err(e) = fs::write(&tmp, data) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        if let Err(e) = fs::rename(&tmp, &target) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        let entry = self.record(&target, filename, "export");
        Ok(SaveResult {
            mode: "auto".into(),
            path: Some(target.to_string_lossy().to_string()),
            name: Some(entry.name.clone()),
            entry: Some(entry),
        })
    }

    /** 把一份刚落盘的文件登记进历史(并返回公开条目)。 */
    fn record(&self, file_path: &Path, requested_name: &str, source: &str) -> PublicEntry {
        let name = file_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("animation")
            .to_string();
        let id = Self::new_id();
        let entry = HistoryEntry {
            id: id.clone(),
            name: name.clone(),
            path: file_path.to_string_lossy().to_string(),
            rel: Path::new(DOWNLOADS_DIR_NAME)
                .join(&name)
                .to_string_lossy()
                .to_string(),
            size: file_size(file_path),
            format: format_of(&name),
            at: stamp_now(),
            created_at: iso_now(),
            frames: read_frame_count(file_path),
            requested: if !requested_name.is_empty() && requested_name != name {
                Some(requested_name.to_string())
            } else {
                None
            },
            source: source.to_string(),
            resolved_path: file_path.to_string_lossy().to_string(),
            missing: false,
        };
        let mut h = self.history.lock().unwrap();
        h.entries.insert(id, entry.clone());
        h.downloads_dir = self.dir.to_string_lossy().to_string();
        write_history(&self.history_file, &h);
        Self::public_entry(&entry)
    }

    /**
     * 把一份外部落盘的文件登记进历史(「另存为」到别处、或调试时手工导入走这条路)。
     * 与 record 的区别只是 source 不同,列表上能区分出「不是自动保存进来的」。
     */
    pub fn record_external(&self, file_path: &Path, requested_name: &str) -> PublicEntry {
        self.record(file_path, requested_name, "export")
    }

    /** 扫描目录下的视频文件(不递归:导出产物只落在这一层)。 */
    fn scan_dir(&self, dir: &Path) -> Vec<(PathBuf, String, u64, SystemTime)> {
        let mut out = Vec::new();
        let names = match fs::read_dir(dir) {
            Ok(n) => n,
            Err(_) => return out,
        };
        for item in names.flatten() {
            let name = item.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let full = dir.join(&name);
            let meta = match fs::metadata(&full) {
                Ok(m) if m.is_file() => m,
                _ => continue,
            };
            let ext = Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext != "mp4" && ext != "avi" && ext != "webm" {
                continue;
            }
            out.push((
                full,
                name,
                meta.len(),
                meta.modified().unwrap_or_else(|_| SystemTime::now()),
            ));
        }
        out
    }

    /**
     * 把「盘上存在但清单里没有」的文件补进历史。
     * 这正是「软件删了再装回来 / 换个 exe 打开」时历史列表还能出现内容的原因。
     * 去重必须先于补录:清单条目可能记着搬家前的绝对路径,此时只有相对路径能对上。
     */
    fn import_from_scan(&self, history: &mut History) -> usize {
        let mut index: HashSet<String> = HashSet::new();
        let ids: Vec<String> = history.entries.keys().cloned().collect();
        for id in ids {
            // 第一遍:先按相对路径对账,顺手把旧绝对路径修正过来
            let fix = match history.entries.get(&id) {
                Some(e) => {
                    let base = Path::new(if !e.name.is_empty() {
                        e.name.as_str()
                    } else if !e.rel.is_empty() {
                        e.rel.as_str()
                    } else {
                        e.path.as_str()
                    })
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                    if base.is_empty() {
                        None
                    } else {
                        let by_rel = self.dir.join(&base);
                        if by_rel.exists() {
                            Some(by_rel)
                        } else {
                            None
                        }
                    }
                }
                None => None,
            };
            if let Some(by_rel) = fix {
                if let Some(e) = history.entries.get_mut(&id) {
                    let base = by_rel
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    e.path = by_rel.to_string_lossy().to_string();
                    e.resolved_path = by_rel.to_string_lossy().to_string();
                    e.rel = Path::new(DOWNLOADS_DIR_NAME)
                        .join(&base)
                        .to_string_lossy()
                        .to_string();
                    e.size = file_size(&by_rel);
                }
            }
            // 第二遍:把这份条目的各种可能路径都登记进索引
            if let Some(e) = history.entries.get(&id) {
                let p = if !e.resolved_path.is_empty() {
                    e.resolved_path.clone()
                } else {
                    e.path.clone()
                };
                if !p.is_empty() {
                    index.insert(normalize_key(Path::new(&p)));
                }
                if !e.rel.is_empty() {
                    if let Some(base) = Path::new(&e.rel).file_name() {
                        index.insert(normalize_key(&self.dir.join(base)));
                    }
                }
                if !e.name.is_empty() {
                    index.insert(normalize_key(&self.dir.join(&e.name)));
                }
            }
        }
        let mut added = 0usize;
        for (full, name, size, mtime) in self.scan_dir(&self.dir) {
            let key = normalize_key(&full);
            if index.contains(&key) {
                // 已在清单里:顺手刷新体积(文件被外部改过时列表不会显示旧数字)
                let hit = history
                    .entries
                    .iter()
                    .find(|(_, e)| {
                        let p = if !e.resolved_path.is_empty() {
                            e.resolved_path.as_str()
                        } else {
                            e.path.as_str()
                        };
                        normalize_key(Path::new(p)) == key
                    })
                    .map(|(id, _)| id.clone());
                if let Some(id) = hit {
                    if let Some(e) = history.entries.get_mut(&id) {
                        e.size = size;
                    }
                }
                continue;
            }
            let id = Self::new_id();
            let entry = HistoryEntry {
                id: id.clone(),
                name: name.clone(),
                path: full.to_string_lossy().to_string(),
                rel: Path::new(DOWNLOADS_DIR_NAME)
                    .join(&name)
                    .to_string_lossy()
                    .to_string(),
                size,
                format: format_of(&name),
                at: stamp(mtime),
                created_at: iso_of(mtime),
                frames: read_frame_count(&full),
                requested: None,
                source: "scan".into(),
                resolved_path: full.to_string_lossy().to_string(),
                missing: false,
            };
            index.insert(key);
            history.entries.insert(id, entry);
            added += 1;
        }
        added
    }

    /**
     * 把清单条目对到真实文件上(就地修正 + 标记是否可见)。三级手段,越靠后越慢:
     *   1) 记下来的绝对路径还在 → 直接用;
     *   2) 软件被搬走/换盘 → 用「相对 downloads 的相对路径」在新目录下找;
     *   3) 文件被单独挪走 → 按 文件名 + 体积(+ 帧数)在几个可疑根目录下搜一遍。
     */
    fn resolve_entry(&self, entry: &mut HistoryEntry, deep: bool) {
        let abs = if entry.path.is_empty() {
            PathBuf::new()
        } else {
            PathBuf::from(&entry.path)
        };
        if !abs.as_os_str().is_empty() && abs.exists() {
            entry.resolved_path = abs.to_string_lossy().to_string();
            entry.missing = false;
            entry.size = file_size(&abs);
            return;
        }
        let base = if !entry.name.is_empty() {
            entry.name.clone()
        } else if !abs.as_os_str().is_empty() {
            abs.file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            Path::new(&entry.rel)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        };
        if !base.is_empty() {
            let by_rel = self.dir.join(&base);
            if by_rel.exists() {
                entry.resolved_path = by_rel.to_string_lossy().to_string();
                entry.path = by_rel.to_string_lossy().to_string();
                entry.rel = Path::new(DOWNLOADS_DIR_NAME)
                    .join(&base)
                    .to_string_lossy()
                    .to_string();
                entry.missing = false;
                entry.size = file_size(&by_rel);
                return;
            }
        }
        if deep {
            if let Some(hit) = self.find_file(entry) {
                entry.resolved_path = hit.to_string_lossy().to_string();
                entry.path = hit.to_string_lossy().to_string();
                entry.missing = false;
                entry.size = file_size(&hit);
                return;
            }
        }
        entry.resolved_path = String::new();
        entry.missing = true;
    }

    /** deep 搜索的候选根目录(与 Electron 版一致:下载目录上一级、软件目录、系统下载目录)。 */
    fn deep_roots(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = Vec::new();
        if let Some(parent) = self.dir.parent() {
            roots.push(parent.to_path_buf());
        }
        roots.push(self.app_dir.clone());
        if let Some(home) = crate::platform::home_dir() {
            roots.push(home.join("Downloads"));
        }
        roots
    }

    /**
     * 在候选根目录下按「文件名 + 体积」找同一份导出。深度封顶 3 层:
     * 用户通常只是把 downloads 文件夹挪到上一层或挪进某个资料文件夹,再深就变成全盘遍历,代价不可接受。
     * 命中体积或帧数任一即可,避免同名不同内容误判。
     */
    fn find_file(&self, entry: &HistoryEntry) -> Option<PathBuf> {
        let want = entry.name.to_lowercase();
        if want.is_empty() {
            return None;
        }
        let want_size = entry.size;
        let want_frames = entry.frames;
        let mut queue: VecDeque<(PathBuf, u32)> = VecDeque::new();
        for root in self.deep_roots() {
            if root.exists() {
                queue.push_back((root, 0));
            }
        }
        let mut seen: HashSet<String> = HashSet::new();
        while let Some((dir, depth)) = queue.pop_front() {
            if !seen.insert(normalize_key(&dir)) {
                continue;
            }
            let items = match fs::read_dir(&dir) {
                Ok(i) => i,
                Err(_) => continue,
            };
            for item in items.flatten() {
                let name = item.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let full = dir.join(&name);
                let meta = match fs::metadata(&full) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if meta.is_dir() {
                    if depth < 3 {
                        queue.push_back((full, depth + 1));
                    }
                    continue;
                }
                if name.to_lowercase() != want {
                    continue;
                }
                if want_size != 0 && meta.len() != want_size {
                    continue;
                }
                if let Some(f) = want_frames {
                    if let Some(actual) = read_frame_count(&full) {
                        if actual != f {
                            continue;
                        }
                    }
                }
                return Some(full);
            }
        }
        None
    }

    /** 下载列表(已与磁盘对账)。deep=true 时额外做一次有限深度的「文件被挪走」搜索。 */
    pub fn list(&self, deep: bool) -> ListResult {
        let mut h = {
            let _guard = self.history.lock().unwrap();
            let _ = &_guard;
            read_history(&self.history_file)
        };
        h.downloads_dir = self.dir.to_string_lossy().to_string();
        let ids: Vec<String> = h.entries.keys().cloned().collect();
        for id in &ids {
            let mut e = h.entries.get(id).cloned().unwrap_or_default();
            self.resolve_entry(&mut e, deep);
            h.entries.insert(id.clone(), e);
        }
        self.import_from_scan(&mut h);
        h.downloads_dir = self.dir.to_string_lossy().to_string();
        write_history(&self.history_file, &h);
        {
            let mut lock = self.history.lock().unwrap();
            *lock = h.clone();
        }
        let mut list: Vec<HistoryEntry> = h.entries.values().cloned().collect();
        /* 新的在前:先按 createdAt,缺了就退回显示时间字符串。
         * 两者都是 'YYYY-...' 形式,字典序比较等价于时间先后。 */
        list.sort_by(|a, b| {
            let ka = if a.created_at.is_empty() {
                a.at.clone()
            } else {
                a.created_at.clone()
            };
            let kb = if b.created_at.is_empty() {
                b.at.clone()
            } else {
                b.created_at.clone()
            };
            kb.cmp(&ka)
        });
        let missing = list.iter().filter(|e| e.missing).count();
        ListResult {
            dir: self.dir.to_string_lossy().to_string(),
            history_file: self.history_file.to_string_lossy().to_string(),
            prompt_on_save: h.prompt_on_save,
            total: list.len(),
            entries: list.iter().map(Self::public_entry).collect(),
            missing,
        }
    }

    /** 删除。with_file=true 连文件一起删;默认只删记录,磁盘上的视频保持不动。 */
    pub fn remove(&self, id: &str, with_file: bool) -> Result<RemoveResult, String> {
        let mut h = {
            let _guard = self.history.lock().unwrap();
            let _ = &_guard;
            read_history(&self.history_file)
        };
        let mut entry = match h.entries.get(id) {
            Some(e) => e.clone(),
            None => return Ok(RemoveResult { ok: false }),
        };
        if with_file {
            self.resolve_entry(&mut entry, false);
            let p = if !entry.resolved_path.is_empty() {
                entry.resolved_path.clone()
            } else {
                entry.path.clone()
            };
            if !p.is_empty() {
                let path = Path::new(&p);
                if path.exists() {
                    /* 用 remove_file(unlink)而不是删目录树:某些环境下(中文目录名 + Windows)
                     * 高级删除 API 会"成功返回但文件还在",unlink 是直接的系统调用。
                     * 失败一定要抛出 —— 静默留下文件会让用户以为删干净了。 */
                    fs::remove_file(path).map_err(|e| format!("文件删除失败:{e}"))?;
                    if path.exists() {
                        return Err(format!("文件删除失败:文件仍存在({p})"));
                    }
                }
            }
        }
        h.entries.remove(id);
        h.downloads_dir = self.dir.to_string_lossy().to_string();
        write_history(&self.history_file, &h);
        {
            let mut lock = self.history.lock().unwrap();
            *lock = h;
        }
        Ok(RemoveResult { ok: true })
    }

    /** 要定位/打开的路径(不传 id = 下载目录本身)。 */
    pub fn resolve_path(&self, id: &str) -> String {
        if id.is_empty() {
            return self.dir.to_string_lossy().to_string();
        }
        let mut h = {
            let _guard = self.history.lock().unwrap();
            let _ = &_guard;
            read_history(&self.history_file)
        };
        let mut entry = match h.entries.get(id) {
            Some(e) => e.clone(),
            None => return self.dir.to_string_lossy().to_string(),
        };
        self.resolve_entry(&mut entry, false);
        h.entries.insert(id.to_string(), entry.clone());
        h.downloads_dir = self.dir.to_string_lossy().to_string();
        write_history(&self.history_file, &h);
        {
            let mut lock = self.history.lock().unwrap();
            *lock = h;
        }
        let p = if !entry.resolved_path.is_empty() {
            entry.resolved_path
        } else {
            entry.path
        };
        if p.is_empty() {
            self.dir.to_string_lossy().to_string()
        } else {
            p
        }
    }
}

/* ============================================================================
 * 单元测试:纯函数部分(文件名收敛、唯一落点、时间戳、JSON 契约字段名)。
 * 这几条是最容易在迁移中"悄悄改坏"的行为 —— Electron 版靠人眼比对,
 * 这里固化成 cargo test 可回归的断言。
 * ========================================================================== */
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_path_separators_and_forbidden_chars() {
        assert_eq!(sanitize_filename("a/b\\c:d*e?f", "x"), "c_d_e_f");
        assert_eq!(
            sanitize_filename("撤离动画-20260214-153012.mp4", "x"),
            "撤离动画-20260214-153012.mp4"
        );
        assert_eq!(sanitize_filename("", "animation"), "animation");
        assert_eq!(sanitize_filename("   ", "animation"), "animation");
    }

    #[test]
    fn sanitize_avoids_windows_trailing_dot_space_and_device_names() {
        assert_eq!(sanitize_filename("name.", "x"), "name_");
        assert_eq!(sanitize_filename("con.mp4", "x"), "_con.mp4");
        assert_eq!(sanitize_filename(".hidden.mp4", "x"), "_hidden.mp4");
    }

    #[test]
    fn sanitize_caps_length_but_keeps_extension() {
        let long = format!("{}.mp4", "a".repeat(300));
        let out = sanitize_filename(&long, "x");
        assert!(out.ends_with(".mp4"));
        assert!(out.chars().count() <= 120);
    }

    #[test]
    fn unique_path_adds_numbered_suffixes_without_overwriting() {
        let dir = std::env::temp_dir().join(format!("dfae-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let first = unique_path(&dir, "clip.mp4", &HashSet::new());
        assert!(first.ends_with("clip.mp4"));
        fs::write(&first, b"x").unwrap();
        let second = unique_path(&dir, "clip.mp4", &HashSet::new());
        assert!(
            second.ends_with("clip (1).mp4"),
            "实际: {}",
            second.display()
        );
        let taken: HashSet<String> = ["clip.mp4".to_string(), "clip (1).mp4".to_string()]
            .into_iter()
            .collect();
        let third = unique_path(&dir, "clip.mp4", &taken);
        assert!(third.ends_with("clip (2).mp4"), "实际: {}", third.display());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_parts_matches_expected_date() {
        /* 1700000000 = 2023-11-14 22:13:20 UTC = 2023-11-15 06:13:20 (UTC+8)
         * 这条断言同时验证了跨日进位:UTC 还在 14 日,本地时间已经进了 15 日。 */
        assert_eq!(local_parts(1_700_000_000), (2023, 11, 15, 6, 13, 20));
        assert_eq!(stamp(SystemTime::UNIX_EPOCH), "1970-01-01 08:00:00");
    }

    #[test]
    fn format_of_uppercases_extension() {
        assert_eq!(format_of("a.Mp4"), "MP4");
        assert_eq!(format_of("noext"), "");
    }

    #[test]
    fn public_entry_uses_electron_field_names() {
        let entry = HistoryEntry {
            id: "f1".into(),
            name: "a.mp4".into(),
            path: "C:\\x\\a.mp4".into(),
            size: 12,
            format: "MP4".into(),
            at: "2026-02-14 15:30:12".into(),
            created_at: "2026-02-14T07:30:12".into(),
            frames: Some(30),
            source: "export".into(),
            resolved_path: "C:\\x\\a.mp4".into(),
            ..Default::default()
        };
        let json = serde_json::to_string(&Manager::public_entry(&entry)).unwrap();
        /* 字段名必须与 electron/downloads.cjs 的 publicEntry 完全一致,否则前端渲染会静默变空。 */
        for key in [
            "\"id\"",
            "\"name\"",
            "\"path\"",
            "\"size\"",
            "\"format\"",
            "\"at\"",
            "\"frames\"",
            "\"source\"",
            "\"missing\"",
        ] {
            assert!(json.contains(key), "缺少字段 {key}: {json}");
        }
        assert!(json.contains("\"missing\":false"));
    }

    #[test]
    fn read_frame_count_reads_avi_total_frames() {
        let dir = std::env::temp_dir().join(format!("dfae-frames-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("t.avi");
        /* 与 Electron 版的 readFrameCount 相同的字节布局:
         *   RIFF(4) size(4) AVI (4) | avih(4) size(4) dwMicroSecPerFrame(4) dwTotalFrames(4)
         * dwTotalFrames 落在 avih 块起点 +12;这条断言就是在钉死这个偏移量,
         * 同时验证"只读文件头、不加载整份文件"的行为。 */
        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&[0, 0, 0, 0]);
        buf.extend_from_slice(b"AVI ");
        buf.extend_from_slice(b"avih");
        buf.extend_from_slice(&56u32.to_le_bytes()); // 块大小(dwSize)
        buf.extend_from_slice(&0u32.to_le_bytes()); // dwMicroSecPerFrame
        buf.extend_from_slice(&123u32.to_le_bytes()); // dwTotalFrames(块内偏移 16)
        buf.extend_from_slice(&[0u8; 36]);
        assert!(buf.len() >= 32, "read_frame_count 要求文件至少 32 字节");
        fs::write(&file, &buf).unwrap();
        /* 落到磁盘再解析:证明读的是文件内容,而不是内存里那份 buffer。 */
        assert_eq!(fs::metadata(&file).unwrap().len(), buf.len() as u64);
        assert_eq!(read_frame_count(&file), Some(123));
        let _ = fs::remove_dir_all(&dir);
    }
}
