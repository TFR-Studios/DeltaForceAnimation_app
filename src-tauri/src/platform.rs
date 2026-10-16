/* ============================================================================
 * 平台外壳能力(打开外链 / 定位文件 / 打开文件)
 *
 * Windows:自己调 ShellExecuteW(全程 UTF-16,中文与空格路径都稳,行为与 Electron 的 shell 一致)。
 * Android:交给 Tauri 官方的 tauri-plugin-opener(它内部就是 Java Intent),
 *          我们**不手写任何 Java/JNI** —— 无法在本机编译验证的代码不该出现在交付物里。
 *
 * 两个平台对外只暴露同样四个函数,调用方(ipc.rs)完全不关心底下是谁。
 * ========================================================================== */
use std::path::PathBuf;

/* app.path() 来自 Manager trait,必须显式引入。 */
use tauri::Manager as _;

/** 当前用户的主目录(Windows 下用于 deep 搜索;Android 上返回 None 即可)。 */
pub fn home_dir() -> Option<PathBuf> {
    if cfg!(target_os = "android") {
        /* Android 没有"用户主目录"这个概念:导出产物落在应用专属目录里,
         * deep 搜索的候选根目录由 Manager 自己按需构造。 */
        return None;
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.trim().is_empty() {
            return Some(PathBuf::from(profile));
        }
    }
    let drive = std::env::var("HOMEDRIVE").ok()?;
    let path = std::env::var("HOMEPATH").ok()?;
    let joined = format!("{drive}{path}");
    if joined.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(joined))
    }
}

/**
 * 导出目录的"上层目录":
 *   · Windows —— 系统「下载」文件夹(%USERPROFILE%\\Downloads),产物落在
 *     <它>/三角洲行动动画编辑器/ 下,与 Electron 版完全一致;
 *   · Android —— 应用数据目录(私有外部目录不可用时 Tauri 也会给这个),
 *     产物落在 <它>/downloads/ 下。这样两个平台共用同一套目录解析逻辑,
 *     区别只是传进来的"起点"不同。详见 android_export_hint()。
 */
pub fn export_base_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    if cfg!(target_os = "android") {
        return app.path().app_local_data_dir().ok();
    }
    let candidate = home_dir()?.join("Downloads");
    if candidate.is_dir() {
        Some(candidate)
    } else {
        None
    }
}

/**
 * Android 导出落点的说明(输出到 logcat,方便真机排障时一眼看到文件在哪):
 *
 * Android 10+ 起,把文件写进**公共** Downloads 必须走 MediaStore(content URI),
 * 不能再用文件路径直接写。本阶段选择应用数据目录,原因是:
 *   · 不需要任何存储权限(符合最小权限原则,也不用处理运行时授权弹窗);
 *   · std::fs 直接可写,与 Windows 侧共用同一套落盘/重名后缀/历史对账逻辑;
 *   · 文件可用数据线(adb pull)或文件管理器找到(路径见日志)。
 * 要改成"落到公共 Downloads 并出现在系统「下载」应用里",需要在本模块加一段
 * MediaStore(contentResolver.insert + openOutputStream)的 Java 调用,
 * **前端与 IPC 契约完全不用动** —— 这是下一阶段的扩展点。
 */
pub fn android_export_hint(dir: &str) {
    if cfg!(target_os = "android") {
        println!("[dfae/mobile] 导出目录:{dir}(应用专属目录,无需存储权限;可用 adb pull 取出)");
    }
}

/**
 * 软件所在目录(下载目录最后的兜底候选)。
 * Windows 开发态 = 工程根目录(target/debug 的上两级),打包态 = exe 所在目录;
 * Android 上这个概念没有意义,返回应用数据目录的上一级即可,仅用于兜底。
 */
pub fn app_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let exe_dir = exe
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    if cfg!(target_os = "android") {
        return exe_dir;
    }
    let is_debug_layout = exe_dir
        .file_name()
        .map(|n| n.eq_ignore_ascii_case("debug"))
        .unwrap_or(false);
    if is_debug_layout {
        if let Some(target) = exe_dir.parent() {
            if target
                .file_name()
                .map(|n| n.eq_ignore_ascii_case("target"))
                .unwrap_or(false)
            {
                if let Some(root) = target.parent() {
                    return root.to_path_buf();
                }
            }
        }
    }
    exe_dir
}

/** 只允许 http(s) —— 避免把任意字符串当命令交给系统「打开方式」。 */
pub fn open_external<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &str) -> bool {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return false;
    }
    #[cfg(dfae_desktop)]
    {
        let _ = app;
        shell_execute(Some("open"), Some(url), None)
    }
    #[cfg(dfae_mobile)]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(url, None::<&str>).is_ok()
    }
}

/** 在资源管理器里选中文件(Windows)/ 打开该文件(Android 没有"定位"这个概念)。 */
pub fn reveal_file<R: tauri::Runtime>(app: &tauri::AppHandle<R>, file: &str) -> bool {
    if file.trim().is_empty() {
        return false;
    }
    #[cfg(dfae_desktop)]
    {
        let _ = app;
        let normalized = file.replace('/', "\\");
        let params = format!("/select,\"{normalized}\"");
        shell_execute(None, Some("explorer.exe"), Some(&params))
    }
    #[cfg(dfae_mobile)]
    {
        /* Android/iOS 上 reveal_item_in_dir 明确返回 UnsupportedPlatform,
         * 所以"定位"退化成"用默认程序打开这个文件" —— 至少让用户看到东西。 */
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_path(file, None::<&str>).is_ok()
    }
}

/** 打开目录本身(Windows 用 shell.openPath;Android 交给 opener)。 */
pub fn open_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>, dir: &str) -> bool {
    if dir.trim().is_empty() {
        return false;
    }
    #[cfg(dfae_desktop)]
    {
        let _ = app;
        shell_execute(Some("open"), Some(dir), None)
    }
    #[cfg(dfae_mobile)]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_path(dir, None::<&str>).is_ok()
    }
}

/** 用系统默认程序打开文件(Windows 用 shell.openPath;Android 交给 opener)。 */
pub fn open_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>, path: &str) -> bool {
    if path.trim().is_empty() {
        return false;
    }
    #[cfg(dfae_desktop)]
    {
        let _ = app;
        shell_execute(Some("open"), Some(path), None)
    }
    #[cfg(dfae_mobile)]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_path(path, None::<&str>).is_ok()
    }
}

/* ---------------------------------------------------------------------------
 * Windows 外壳调用(ShellExecuteW)
 * ------------------------------------------------------------------------- */
#[cfg(dfae_desktop)]
fn shell_execute(operation: Option<&str>, file: Option<&str>, params: Option<&str>) -> bool {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    let op = operation.map(wide);
    let f = match file {
        Some(f) if !f.trim().is_empty() => wide(f),
        _ => return false,
    };
    let p = params.map(wide);
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ref().map(|v| v.as_ptr()).unwrap_or(std::ptr::null()),
            f.as_ptr(),
            p.as_ref().map(|v| v.as_ptr()).unwrap_or(std::ptr::null()),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    (result as isize) > 32
}
