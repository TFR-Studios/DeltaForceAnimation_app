/* ============================================================================
 * 渲染进程可调用的 IPC 命令(对应 electron/main.cjs 的 ipcMain.handle 那一批)
 *
 * 命令命名规则:dfae_info 对应 Electron 的 dfae:info,dfae_downloads_save 对应 dfae:downloads-save;
 * 前端的 window.dfaeDesktop / window.dfaeDownloads 由 webview/dfae-bridge.js 包装成同名方法,
 * 所以 src/ 里的调用代码一行都不用改 —— Windows 与 Android 的命令名、参数、返回值**完全一致**。
 *
 * 平台差异只出现在两个地方,都用 cfg 分开:
 *   · dfae_downloads_save_as:桌面弹系统「另存为」(rfd);Android 没有等价 UI,
 *     直接落到导出目录并登记历史(返回值形状保持一致,前端不用判断平台);
 *   · 外壳操作(打开外链/定位/打开):交给 platform 模块分流。
 * ========================================================================== */
use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};
/* 注意:Manager 在这里指 Tauri 的 trait(提供 path() / try_state() / manage()),
 * 与 crate::downloads::Manager(下载历史控制器这个结构体)同名不同物,所以只允许以 trait 身份出现。 */
use tauri::{AppHandle, Manager as _, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::downloads::RemoveResult;

/* 最近一次导出产物的绝对路径:dfae:info 会把它报给前端,排障时能一眼看到最后一次落盘到了哪里。 */
static LAST_EXPORT: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/** 读最近一次导出的绝对路径(供 dfae_info 报告,也便于以后加「打开上次导出」这类入口)。 */
fn last_export() -> String {
    LAST_EXPORT
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .unwrap_or_default()
}

type Res<T> = Result<T, String>;

/* 桥接层是否已经落到**当前文档**上(由 webview/dfae-bridge.js 末尾的回执置位)。
 * 存在的理由见 lib.rs 的注入重试循环:Android 上没办法在文档加载前注入,
 * 只能反复 eval 直到这一枪真的打中。 */
static BRIDGE_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn bridge_ready() -> bool {
    BRIDGE_READY.load(std::sync::atomic::Ordering::Relaxed)
}

/** 桥接层落位回执(由注入的脚本自己调用,前端不感知)。 */
#[tauri::command]
pub fn dfae_bridge_ready() {
    BRIDGE_READY.store(true, std::sync::atomic::Ordering::Relaxed);
}

/*
 * 取下载历史控制器。
 * 刻意返回借用而不是 tauri::State:State<'_, T> 里的匿名生命周期在 helper 函数上会与
 * CommandArg 的 'de 对不上(报 expected a type, found a trait),而 &T 完全没有这个问题。
 */
fn manager<R: Runtime>(app: &AppHandle<R>) -> Res<&crate::downloads::Manager> {
    let state = app
        .try_state::<crate::downloads::Manager>()
        .ok_or_else(|| "下载历史尚未就绪(Manager 未注册)".to_string())?;
    Ok(state.inner())
}

fn remember_export(path: &str) {
    if let Ok(mut slot) = LAST_EXPORT.lock() {
        *slot = Some(path.to_string());
    }
}

/* ---------------------------------------------------------------------------
 * 应用信息(对应 dfae:info)
 * ------------------------------------------------------------------------- */
#[derive(Serialize)]
pub struct InfoOut {
    version: String,
    name: String,
    electron: Option<String>,
    chrome: Option<String>,
    node: Option<String>,
    platform: String,
    arch: String,
    packaged: bool,
    #[serde(rename = "downloadsDir")]
    downloads_dir: String,
    #[serde(rename = "userDataDir")]
    user_data_dir: String,
    #[serde(rename = "exportDir")]
    export_dir: String,
    #[serde(rename = "historyFile")]
    history_file: String,
    /* 最近一次导出产物的绝对路径(排障用;前端不读它)。 */
    #[serde(rename = "lastExport")]
    last_export: String,
    /* 运行外壳:Windows 是 tauri,Android 是 tauri-android。
     * Electron 版没有这个字段,前端不读它,只为排障时一眼看清跑在哪个壳里。 */
    shell: String,
}

#[tauri::command]
pub fn dfae_info<R: Runtime>(app: AppHandle<R>) -> Res<InfoOut> {
    let user_data_dir = app
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let (export_dir, history_file) = match app.try_state::<crate::downloads::Manager>() {
        Some(m) => (m.dir(), m.history_file()),
        None => (String::new(), String::new()),
    };
    let downloads_dir = crate::platform::export_base_dir(&app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(InfoOut {
        version: app.package_info().version.to_string(),
        name: app
            .config()
            .product_name
            .clone()
            .unwrap_or_else(|| app.package_info().name.clone()),
        /* Electron / Chromium / Node 的版本号在 Tauri 下没有对应概念,固定 null:
         * 前端若读会拿到 null 而不是抛错,不会出现 undefined 崩在上层。 */
        electron: None,
        chrome: None,
        node: None,
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        packaged: !cfg!(debug_assertions),
        downloads_dir,
        user_data_dir,
        export_dir,
        history_file,
        last_export: last_export(),
        shell: if cfg!(target_os = "android") {
            "tauri-android".to_string()
        } else {
            "tauri".to_string()
        },
    })
}

/* ---------------------------------------------------------------------------
 * 外壳能力(对应 dfae:open-external / dfae:reveal-file)
 * ------------------------------------------------------------------------- */
#[tauri::command]
pub fn dfae_open_external<R: Runtime>(app: AppHandle<R>, url: String) -> bool {
    crate::platform::open_external(&app, &url)
}

#[tauri::command]
pub fn dfae_reveal_file<R: Runtime>(app: AppHandle<R>, file: String) -> bool {
    crate::platform::reveal_file(&app, &file)
}

/* ---------------------------------------------------------------------------
 * 下载列表 / 下载历史(对应 dfae:downloads-*)
 * ------------------------------------------------------------------------- */
#[tauri::command]
pub fn dfae_downloads_list<R: Runtime>(
    app: AppHandle<R>,
    deep: Option<bool>,
) -> Res<crate::downloads::ListResult> {
    let m = manager(&app)?;
    Ok(m.list(deep.unwrap_or(false)))
}

#[tauri::command]
pub fn dfae_downloads_prompt<R: Runtime>(app: AppHandle<R>, on: bool) -> Res<bool> {
    let m = manager(&app)?;
    Ok(m.set_prompt_on_save(on))
}

#[tauri::command]
pub fn dfae_downloads_rename(_app: AppHandle, _id: String, _name: String) -> Res<Value> {
    /* 前端已经把「重命名」入口整个删掉了(见 src/main.ts 的注释),这里保留命令只为兼容旧调用面;
     * 真被调用时明确报错,而不是静默什么都不做。 */
    Err("重命名入口已移除".to_string())
}

#[tauri::command]
pub fn dfae_downloads_remove<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    mode: Option<String>,
) -> Res<RemoveResult> {
    let m = manager(&app)?;
    m.remove(&id, mode.as_deref() == Some("file"))
}

#[tauri::command]
pub fn dfae_downloads_reveal<R: Runtime>(app: AppHandle<R>, id: Option<String>) -> Res<bool> {
    let m = manager(&app)?;
    let target = m.resolve_path(id.as_deref().unwrap_or(""));
    if target.is_empty() {
        return Ok(false);
    }
    if Path::new(&target).is_file() {
        Ok(crate::platform::reveal_file(&app, &target))
    } else {
        Ok(crate::platform::open_dir(&app, &target))
    }
}

#[tauri::command]
pub fn dfae_downloads_open<R: Runtime>(app: AppHandle<R>, id: String) -> Res<bool> {
    let m = manager(&app)?;
    let target = m.resolve_path(&id);
    if target.is_empty() || !Path::new(&target).is_file() {
        return Ok(false);
    }
    Ok(crate::platform::open_path(&app, &target))
}

/* ---------------------------------------------------------------------------
 * 导出落盘
 * ------------------------------------------------------------------------- */
/**
 * 取文件名的两种写法都要认:扁平的 { filename, ... } 与嵌套的 { args: { filename, ... } } ——
 * Tauri 的参数包装方式在不同写法下并不统一,两种都认可以避免因为前端写法差异丢掉文件名。
 */
fn pick_filename(value: &Value) -> Option<String> {
    if let Some(name) = value.get("filename").and_then(|v| v.as_str()) {
        return Some(name.to_string());
    }
    value
        .get("args")
        .and_then(|a| a.get("filename"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/**
 * 把一次导出落盘的载荷还原成 (文件名, 字节流)。
 *
 * 依据 Tauri 官方的原始请求通道(tauri::ipc::Request):
 *   · body 是 InvokeBody::Raw  → 前端把 Uint8Array 直接当载荷时走这条(整块字节不经 JSON 数字数组);
 *   · body 是 InvokeBody::Json → { filename, bytes: [...] } 的通用形态,也是当前桥接层实际使用的形态。
 * 前端若只给了裸字节:文件名退回中性名,唯一性由 unique_path 的 (1)(2) 后缀保证。
 */
/**
 * 标准 base64 解码(+/ 表,允许 = 补齐,忽略换行与空格)。
 *
 * 为什么自己写而不是引 crate:只有二十来行,而且它只服务导出落盘这一条热路径 ——
 * 为它多一个依赖不划算。
 *
 * 为什么移动端要 base64 而不是数字数组:`{ bytes: [..] }` 在 Tauri 侧会先被建成整棵
 * serde_json::Value 树(每个元素约 16 字节),30MB 的导出就是约 5 亿字节,手机进程必然 OOM;
 * 而一个 base64 字符串在 Value 里只是一段连续的 String,没有逐元素开销。
 */
fn base64_decode(s: &str) -> Res<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(s.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for ch in s.bytes() {
        let v = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return Err(format!("base64 里出现非法字符 0x{ch:02x}")),
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

fn extract_payload(request: &tauri::ipc::Request<'_>) -> Res<(String, Vec<u8>)> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            if bytes.is_empty() {
                return Err("导出落盘收到 0 字节".to_string());
            }
            Ok(("animation.mp4".to_string(), bytes.clone()))
        }
        tauri::ipc::InvokeBody::Json(value) => {
            let filename = pick_filename(value).unwrap_or_else(|| "animation.mp4".to_string());
            /* 移动端(以及愿意走这条路的调用方):base64 单串,没有逐元素开销。
             * 扁平 { data_b64 } 与嵌套 { args: { data_b64 } } 两种写法都认。 */
            let b64 = value
                .get("data_b64")
                .or_else(|| value.get("args").and_then(|a| a.get("data_b64")))
                .and_then(|v| v.as_str());
            if let Some(text) = b64 {
                let bytes = base64_decode(text)?;
                if bytes.is_empty() {
                    return Err("导出落盘收到 0 字节".to_string());
                }
                return Ok((filename, bytes));
            }
            /* 扁平 { bytes: [...] } 与嵌套 { args: { bytes: [...] } } 两种写法都认。 */
            let bytes_value = value
                .get("bytes")
                .or_else(|| value.get("args").and_then(|a| a.get("bytes")));
            let arr = bytes_value
                .and_then(|b| b.as_array())
                .ok_or_else(|| "导出落盘参数缺少 bytes".to_string())?;
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                out.push(item.as_u64().unwrap_or(0) as u8);
            }
            if out.is_empty() {
                return Err("导出落盘收到 0 字节".to_string());
            }
            Ok((filename, out))
        }
    }
}

/** 请求头里带出来的文件名:头值只能是可见 ASCII,所以桥接层用 encodeURIComponent 编码,
 *  这里解回 UTF-8。只处理 %XX,其它字符原样保留(encodeURIComponent 就是这么输出的)。 */
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hi = (b[i + 1] as char).to_digit(16);
            let lo = (b[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/**
 * 载荷 = 字节流 + 文件名。
 *
 * 文件名优先取请求头 x-dfae-filename:移动端走 Tauri 的 Raw 通道(InvokeBody::Raw),
 * 载荷是纯字节,参数里塞不进文件名 —— 官方为这种场景提供了 Request::headers,
 * 桥接层就是这么用的(见 webview/dfae-bridge.js 的 saveToGallery)。
 * 桌面端仍走原来的 JSON 形态,那时这个头不存在,回落到载荷里的 filename。
 */
fn payload(request: &tauri::ipc::Request<'_>) -> Res<(String, Vec<u8>)> {
    let (fallback, bytes) = extract_payload(request)?;
    let name = request
        .headers()
        .get("x-dfae-filename")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(fallback);
    Ok((name, bytes))
}

/** 按扩展名给 MediaStore 一个 MIME:它据此决定这条媒体进哪个集合、图库要不要收录。 */
#[cfg(target_os = "android")]
fn mime_of(name: &str) -> &'static str {
    match std::path::Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        _ => "video/mp4",
    }
}

/**
 * 渲染进程把导出字节流传过来落盘(对应 dfae:downloads-save)。
 * 返回 { mode: auto, path, name, entry } 或 { mode: prompt }。
 *
 * 两个平台完全一致:用户关掉「自动保存」时也回 mode=prompt,由桥接层决定改走哪条路
 * (桌面弹系统另存为、Android 直接落盘并登记历史)。
 */
#[tauri::command]
pub fn dfae_downloads_save<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Res<Value> {
    let (filename, bytes) = payload(&request)?;

    /* ---------------- Android:写进系统相册 ----------------
     * 落点必须是 MediaStore:相册只索引 MediaStore 里的媒体项,写到应用私有目录
     * 就是「导出成功但相册里找不到」。API 29+ 插入自己的媒体项零权限,
     * 具体见 src/mediastore.rs 顶部说明。
     * 这里不登记下载历史:那条历史是桌面「下载列表」用的、存的是文件路径,
     * 而相册里的东西是 content:// URI,和它那套定位/打开/重命名对不上。 */
    #[cfg(target_os = "android")]
    {
        let name = crate::downloads::sanitize_filename(&filename, "animation.mp4");
        let saved = crate::mediastore::save(&name, mime_of(&name), &bytes)?;
        remember_export(&saved.uri);
        notify_saved(&app, &saved.display_name, bytes.len());
        return Ok(json!({
            "mode": "auto",
            "name": saved.display_name,
            "path": saved.uri,
            "gallery": true,
        }));
    }

    /* ---------------- 桌面:落到下载目录并登记历史(行为不变) ---------------- */
    #[cfg(not(target_os = "android"))]
    {
        let m = manager(&app)?;
        let result = m
            .save_bytes(&bytes, &filename)
            .map_err(|e| format!("导出落盘失败:{e}"))?;
        if result.mode == "auto" {
            if let Some(path) = result.path.clone() {
                remember_export(&path);
                notify_saved(&app, &result.name.clone().unwrap_or(filename), bytes.len());
            }
        }
        serde_json::to_value(&result).map_err(|e| format!("序列化落盘结果失败:{e}"))
    }
}

/**
 * 「另存为」。返回值形状两个平台一致:
 *
 * 注意(移动端):桥接层在 Android 上**不再走这条路** —— 手机的落点只有系统相册一处
 * (见 dfae_downloads_save 的 Android 分支),没有询问保存位置这回事。
 * 这里的 dfae_mobile 分支保留为兜底(万一有调用方直接调它)。
 *   · 成功   → { canceled: false, path, name, entry }
 *   · 取消   → { canceled: true }
 */
#[tauri::command]
pub fn dfae_downloads_save_as<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Res<Value> {
    let m = manager(&app)?;
    let (filename, bytes) = extract_payload(&request)?;

    /* 桌面:弹系统「另存为」(rfd),对应 Electron 的 setSaveDialogOptions 分支。 */
    #[cfg(dfae_desktop)]
    let target = {
        let dir = m.dir();
        let picked = rfd::FileDialog::new()
            .set_title("保存导出视频")
            .set_directory(&dir)
            .set_file_name(&filename)
            .add_filter("视频", &["mp4", "avi", "webm"])
            .add_filter("所有文件", &["*"])
            .save_file();
        match picked {
            Some(p) => p,
            None => return Ok(json!({ "canceled": true })),
        }
    };

    /* Android:没有等价的系统"另存为"UI。为了保持与桌面相同的返回值形状,这里退化成
     * "写到导出目录并登记历史",对前端来说等于一次成功的保存,不需要判断平台。 */
    #[cfg(dfae_mobile)]
    let target = {
        let dir = std::path::PathBuf::from(m.dir());
        let _ = fs::create_dir_all(&dir);
        let safe = crate::downloads::sanitize_filename(&filename, "animation.mp4");
        let candidate = dir.join(&safe);
        if candidate.exists() {
            let stem = std::path::Path::new(&safe)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "animation".to_string());
            let ext = std::path::Path::new(&safe)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let mut n = 1;
            loop {
                let next = dir.join(format!("{stem} ({n}){ext}"));
                if !next.exists() {
                    break next;
                }
                n += 1;
                if n > 999 {
                    break candidate.clone();
                }
            }
        } else {
            candidate
        }
    };

    fs::write(&target, &bytes).map_err(|e| format!("写入失败:{e}"))?;
    let entry = m.record_external(&target, &filename);
    let path = target.to_string_lossy().to_string();
    remember_export(&path);
    notify_saved(&app, &entry.name, bytes.len());
    Ok(json!({
        "canceled": false,
        "path": path,
        "name": entry.name,
        "entry": entry,
    }))
}

/* ---------------------------------------------------------------------------
 * 系统通知(桌面:Windows toast;Android:NotificationManager)
 * ------------------------------------------------------------------------- */
/** 导出完成提示。点击通知会激活应用窗口;文件位置可在「下载列表」里定位。 */
pub fn notify_saved<R: Runtime>(app: &AppHandle<R>, name: &str, bytes: usize) {
    let size_mb = bytes as f64 / 1024.0 / 1024.0;
    /* 手机上文件在系统相册里,提示「下载列表」会把人引到不存在的地方去 */
    let body = if cfg!(target_os = "android") {
        format!("{name}\n{size_mb:.1} MB · 已保存到手机相册")
    } else {
        format!("{name}\n{size_mb:.1} MB · 可在下载列表里定位")
    };
    let _ = app
        .notification()
        .builder()
        .title("导出完成")
        .body(body)
        .show();
}

/** 导出中断/失败提示(对应 Electron 的「导出未完成」通知)。 */
#[allow(dead_code)]
pub fn notify_failed<R: Runtime>(app: &AppHandle<R>, name: &str, reason: &str) {
    let body = if reason.is_empty() {
        format!("{name} 已中断")
    } else {
        format!("{name}\n{reason}")
    };
    let _ = app
        .notification()
        .builder()
        .title("导出未完成")
        .body(body)
        .show();
}
