/* ============================================================================
 * 三角洲行动动画编辑器 · Tauri v2 应用装配
 *
 * 桌面(Windows)与移动端(Android)共用同一套业务代码,差异全部用 cfg 分开:
 *
 *   [desktop]
 *     · 内置随机端口本地 HTTP 服务(httpd 模块):webview 从 http://127.0.0.1:<随机端口> 加载,
 *       保住 WebCodecs 需要的安全上下文;
 *     · 单实例锁定、窗口位置/大小记忆;
 *     · 外壳操作走 ShellExecuteW(platform 模块)。
 *
 *   [mobile / Android]
 *     · 不启本地服务:页面走 Tauri 内置的 asset 协议(asset://localhost);
 *     · 没有单实例与窗口记忆(移动端不存在这两个概念),插件用 cfg(dfae_desktop) 排除,
 *       这样 Android 的 Java/Gradle 侧也不会多出用不到的组件;
 *     · 外壳操作交给 tauri-plugin-opener(Java Intent),我们不手写 JNI;
 *     · 窗口由 Tauri 依据 tauri.conf.json 自动创建(所以这里不显式 build),
 *       我们只给它注入 window.dfaeDesktop / window.dfaeDownloads 适配层。
 *
 * 两条铁律:
 *   1) 前端(src/)一行都不改 —— 两个平台注入的桥接层与 Windows 完全一致;
 *   2) 不能破坏 Windows 构建 —— 桌面路径的代码与行为保持原样,只是换了模块名。
 * ========================================================================== */
mod downloads;
mod ipc;
mod platform;
/* 「保存到相册」:只有 Android 有 MediaStore,别的平台连这个模块都不编译。 */
#[cfg(target_os = "android")]
mod mediastore;

#[cfg(dfae_desktop)]
mod httpd;

#[cfg(dfae_desktop)]
use tauri_plugin_window_state as window_state;

use std::path::PathBuf;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/* 页面脚本之前注入的适配层源码:编译期嵌进 exe / apk,不依赖额外静态资源。 */
const DFAE_BRIDGE_JS: &str = include_str!("../webview/dfae-bridge.js");

/* 注入桥接层之前先告诉它自己跑在哪个壳里。
 * 为什么需要:移动端的导出落盘要走「Raw 通道 + MediaStore 写相册」,而桌面端那条
 * JSON 数字数组通道已经稳定运行,不能动。两边的脚本只差这一行,没必要维护两份。
 * 用 cfg! 而不是 #[cfg]:cfg! 展开成 true/false 字面量,在 const 上下文里是合法的。 */
const DFAE_PLATFORM_JS: &str = if cfg!(target_os = "android") {
    "window.__DFAE_MOBILE__ = true;"
} else {
    "window.__DFAE_MOBILE__ = false;"
};

fn bridge_script() -> String {
    let mut s = String::with_capacity(DFAE_PLATFORM_JS.len() + DFAE_BRIDGE_JS.len() + 2);
    s.push_str(DFAE_PLATFORM_JS);
    s.push('\n');
    s.push_str(DFAE_BRIDGE_JS);
    s
}

/* 窗口 label:固定一个。桌面端单实例插件按它把旧窗口拉回前台;
 * 移动端 Tauri 也会用这个 label 建主窗口,所以 setup 里能直接取到它。 */
const MAIN_WINDOW_LABEL: &str = "main";

/* 站点来源地址:桌面端在 setup 里算出来后记住,单实例回调需要重建窗口时要用。 */
#[cfg(dfae_desktop)]
static SITE_ORIGIN: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/* 调试构建里清掉这两个历史遗留变量,避免子进程继承时出现控制台窗口自己冒出来这类怪现象。 */
fn clean_env() {
    if cfg!(desktop) && cfg!(debug_assertions) {
        std::env::remove_var("RUST_BACKTRACE");
        std::env::remove_var("RUST_LOG");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    /* 单实例:第二次双击只把已有窗口拿到前台,绝不打开第二个进程。
     * 移动端没有"多开"这回事,整个插件在 mobile 下不注册。 */
    #[cfg(dfae_desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                if win.is_minimized().unwrap_or(false) {
                    let _ = win.unminimize();
                }
                let _ = win.show();
                let _ = win.set_focus();
                return;
            }
            /* 没有窗口 = 第一轮进程异常退出后残留了没有窗口的实例(实测:强制结束进程可能留下
             * 一个 0 线程的残影,它仍占着单实例锁)。这时直接把窗口重建出来,避免"双击没反应"。 */
            eprintln!("[dfae] 单实例锁的持有者没有窗口,改为重建主窗口");
            if let Err(e) = build_main_window(app) {
                eprintln!("[dfae] 重建主窗口失败: {e}");
            }
        }));
    }

    builder
        /* 系统通知:桌面走 Windows toast,Android 走 NotificationManager(插件内部已处理
         * Android 13+ 的 POST_NOTIFICATIONS 运行时权限请求)。 */
        .plugin(tauri_plugin_notification::init())
        /* 打开外链 / 打开文件 / 打开目录:Android 上由这个插件的 Java Intent 实现。 */
        .plugin(tauri_plugin_opener::init())
        /* 窗口位置/大小记忆:桌面专属 —— 移动端没有"拖动窗口/最大化"这回事,
         * 所以整个插件在 mobile 下不注册(Android 的 Java/Gradle 侧也就不会多出用不到的组件)。
         * 状态文件放应用数据目录,与 Electron 的 userData/window-state.json 同位置。 */
        .plugin({
            #[cfg(dfae_desktop)]
            {
                window_state::Builder::new()
                    .with_state_flags(window_state::StateFlags::all())
                    .with_filename("window-state.json")
                    .build()
            }
            #[cfg(dfae_mobile)]
            {
                /* 占位空插件:让 builder 的链式写法在两个平台上完全一致。 */
                tauri::plugin::Builder::<tauri::Wry>::new("dfae-noop-desktop-only").build()
            }
        })
        .invoke_handler(tauri::generate_handler![
            ipc::dfae_info,
            ipc::dfae_open_external,
            ipc::dfae_reveal_file,
            ipc::dfae_downloads_list,
            ipc::dfae_downloads_prompt,
            ipc::dfae_downloads_save,
            ipc::dfae_downloads_save_as,
            ipc::dfae_downloads_rename,
            ipc::dfae_downloads_remove,
            ipc::dfae_downloads_reveal,
            ipc::dfae_downloads_open,
            /* 桥接层落位回执:只由注入的脚本调用,前端不感知 */
            ipc::dfae_bridge_ready,
        ])
        .setup(|app| {
            clean_env();

            let user_data_dir: PathBuf = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let _ = std::fs::create_dir_all(&user_data_dir);

            /* 下载历史控制器:清单放应用数据目录。
             * 导出目录:
             *   · Windows —— 系统「下载」文件夹下的应用子目录(与 Electron 版一致);
             *   · Android —— 应用专属目录(见 platform::android_export_hint 的说明),
             *     不需要任何存储权限,数据线/文件管理器都能找到。 */
            let manager = downloads::Manager::new(
                user_data_dir.clone(),
                platform::export_base_dir(app.handle()),
                platform::app_dir(),
                None,
            );
            let export_dir = manager.dir();
            platform::android_export_hint(&export_dir);
            app.manage(manager);

            /* ---------------- 站点来源 ---------------- */
            #[cfg(dfae_desktop)]
            {
                let dev_url_override = std::env::var("DFAE_DEV_URL")
                    .ok()
                    .filter(|s| !s.trim().is_empty());
                /* 只有 debug 构建才认配置里的 build.devUrl:release 构建必须走内置服务,
                 * 否则打包出来的 exe 会去连根本不存在的 http://localhost:5173(白屏)。 */
                let configured_dev_url = if cfg!(debug_assertions) {
                    app.config().build.dev_url.as_ref().map(|u| u.to_string())
                } else {
                    None
                };
                let app_dir = platform::app_dir();

                let choice = resolve_url_choice(
                    dev_url_override,
                    configured_dev_url,
                    cfg!(debug_assertions),
                );
                let (url, origin_desc) = match choice {
                    UrlChoice::Dev(origin) => {
                        let parsed = origin
                            .parse()
                            .unwrap_or_else(|_| panic!("开发地址不是合法 URL: {origin}"));
                        (WebviewUrl::External(parsed), "dev".to_string())
                    }
                    UrlChoice::Builtin => {
                        /* 资源来源:优先 Tauri 的资源解析器 —— 生产环境前端产物是在**构建期**
                         * 编进 exe 的,target/release 下根本没有 dist 目录,去磁盘上找必然全 404。 */
                        let resolver = app.asset_resolver();
                        let from_resolver = {
                            let probe = httpd::TauriAssets::new(resolver);
                            httpd::Assets::exists(&probe, "index.html")
                        };
                        let assets: Box<dyn httpd::Assets> = if from_resolver {
                            Box::new(httpd::TauriAssets::new(app.asset_resolver()))
                        } else {
                            let dist_dir = resolve_dist_dir(app.handle(), &app_dir);
                            if !dist_dir.join("index.html").exists() {
                                eprintln!(
                                    "[dfae] 缺少构建产物 {} —— 请先执行 npm run build,或用 npm run tauri dev。",
                                    dist_dir.display()
                                );
                            }
                            Box::new(httpd::FsAssets::new(dist_dir))
                        };
                        println!("[dfae] 站点资源来源: {}", assets.origin_desc());
                        let (origin, _handle) = httpd::start(assets)?;
                        println!("[dfae] 内置静态服务已启动: {origin}");
                        let parsed = origin.parse().expect("内置服务地址异常");
                        (WebviewUrl::External(parsed), "builtin".to_string())
                    }
                };
                println!("[dfae] 页面来源({origin_desc}): {url:?}");
                println!("[dfae] 导出目录: {export_dir}");
                println!("[dfae] 应用数据目录: {}", user_data_dir.display());

                let origin_string = url_to_string(&url);
                let _ = SITE_ORIGIN.set(origin_string.clone());
                println!("[dfae] 站点地址将被记住: {origin_string}");

                build_main_window(&app.handle().clone())?;
            }

            /* ---------------- 移动端:给 Tauri 自动创建好的主窗口注入适配层 ---------------- */
            #[cfg(dfae_mobile)]
            {
                println!("[dfae] 导出目录: {export_dir}");
                println!("[dfae] 应用数据目录: {}", user_data_dir.display());
                let label = app
                    .config()
                    .app
                    .windows
                    .first()
                    .map(|w| w.label.clone())
                    .unwrap_or_else(|| MAIN_WINDOW_LABEL.to_string());
                match app.get_webview_window(&label) {
                    Some(window) => {
                        /* 为什么要重试着注入,而不是 eval 一次就算数:
                         * 桌面端有 initialization_script,每个文档加载前自动跑一遍;
                         * Android 上没有等价物。setup 里这一枪往往打在**还没加载页面的空文档**上,
                         * 随文档被替换就丢了 —— 表现是 window.dfaeDownloads 永远不存在,
                         * 于是 isDesktopDownloads 为假、导出走 <a download>,而 WebView 里
                         * 根本没有下载监听:提示「导出完成」,文件却哪儿都没有。
                         * 桥接层自身是幂等的(开头就 if (window.dfaeDesktop && window.dfaeDownloads) return;),
                         * 且末尾会回执一次 dfae_bridge_ready,收到回执即停。 */
                        let _ = window.eval(&bridge_script());
                        let handle = window.clone();
                        std::thread::spawn(move || {
                            for attempt in 1..=40 {
                                std::thread::sleep(std::time::Duration::from_millis(250));
                                if ipc::bridge_ready() {
                                    println!("[dfae] 桥接层已确认落位(第 {attempt} 次尝试)");
                                    return;
                                }
                                let _ = handle.eval(&bridge_script());
                            }
                            eprintln!("[dfae] 桥接层注入未收到回执:前端的 window.dfaeDesktop / dfaeDownloads 可能不可用");
                        });
                    }
                    None => {
                        eprintln!("[dfae] 没有找到 label={label} 的移动端窗口,桥接层未注入");
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/* ---------------------------------------------------------------------------
 * 窗口构建(仅桌面端需要;移动端的窗口由 Tauri 依据 tauri.conf.json 自动创建)
 * ------------------------------------------------------------------------- */
#[cfg(dfae_desktop)]
fn url_to_string(url: &WebviewUrl) -> String {
    match url {
        WebviewUrl::External(u) => u.to_string(),
        WebviewUrl::App(p) => p.to_string_lossy().to_string(),
        _ => String::new(),
    }
}

/**
 * 建主窗口。setup 与「单实例锁持有者没有窗口」两条路都走这里,
 * 保证窗口参数(标题/尺寸/注入脚本)永远只有一份定义。
 */
#[cfg(dfae_desktop)]
fn build_main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::WebviewWindow<R>> {
    let origin = SITE_ORIGIN
        .get()
        .cloned()
        .unwrap_or_else(|| "about:blank".to_string());
    let parsed: tauri::Url = origin
        .parse()
        .map_err(|e| tauri::Error::AssetNotFound(format!("站点地址不合法({origin}): {e}")))?;

    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::External(parsed))
        .title("三角洲行动动画编辑器")
        .inner_size(1480.0, 940.0)
        .min_inner_size(1024.0, 640.0)
        .resizable(true)
        .center()
        .visible(false)
        .initialization_script(bridge_script())
        .build()?;

    /* 首帧画完再显示,避免起窗白闪(Electron 版是 show:false + ready-to-show)。
     * window-state 插件会在窗口 ready 时应用上次的几何尺寸,这里只负责把它显示出来。 */
    window.show()?;
    Ok(window)
}

/* ---------------------------------------------------------------------------
 * 站点根目录解析(仅桌面端兜底用)
 * ------------------------------------------------------------------------- */
#[cfg(dfae_desktop)]
pub fn resolve_dist_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    app_dir: &std::path::Path,
) -> PathBuf {
    let candidates: Vec<PathBuf> = [
        Some(app_dir.join("dist")),
        app.path().resource_dir().ok().map(|r| r.join("dist")),
        app.path()
            .resource_dir()
            .ok()
            .map(|r| r.join("_up_").join("dist")),
    ]
    .into_iter()
    .flatten()
    .collect();

    for candidate in &candidates {
        if candidate.join("index.html").exists() {
            return candidate.clone();
        }
    }
    candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| app_dir.join("dist"))
}

/* ---------------------------------------------------------------------------
 * 站点来源决策(抽成纯函数,便于单测钉死行为)
 * ------------------------------------------------------------------------- */

#[derive(Debug, PartialEq, Eq)]
pub enum UrlChoice {
    /** 走外部地址(vite dev server 或调用方指定的地址) */
    Dev(String),
    /** 走内置随机端口静态服务(frontendDist)/ 移动端走 Tauri 内置 asset 协议 */
    Builtin,
}

/**
 * 页面来源优先级:
 *   1) 环境变量 DFAE_DEV_URL —— 唯一一个在 release 里也生效的逃生口;
 *   2) 配置里的 build.devUrl —— **只有 debug 构建才认**。tauri build 出来的 exe 里 devUrl
 *      仍然是 http://localhost:5173,若 release 也认它,打包版本就会去连一个不存在的开发
 *      服务器:表现是窗口全白。这条规则由单测钉死。
 *   3) 其余情况走内置服务。
 *
 * 移动端不存在 DFAE_DEV_URL 这种注入方式,且页面本来就由 Tauri 的 asset 协议提供,
 * 所以恒为 Builtin(调用方在 mobile 下不会进这个分支)。
 */
pub fn resolve_url_choice(
    env_dev_url: Option<String>,
    configured_dev_url: Option<String>,
    is_debug: bool,
) -> UrlChoice {
    if let Some(env) = env_dev_url.filter(|s| !s.trim().is_empty()) {
        return UrlChoice::Dev(env);
    }
    if is_debug {
        if let Some(configured) = configured_dev_url.filter(|s| !s.trim().is_empty()) {
            return UrlChoice::Dev(configured);
        }
    }
    UrlChoice::Builtin
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_never_uses_configured_dev_url() {
        /* 这是「打包后白屏」的直接原因所在:release 必须走内置服务。 */
        let choice = resolve_url_choice(None, Some("http://localhost:5173".to_string()), false);
        assert_eq!(choice, UrlChoice::Builtin);
    }

    #[test]
    fn debug_uses_configured_dev_url() {
        let choice = resolve_url_choice(None, Some("http://localhost:5173".to_string()), true);
        assert_eq!(choice, UrlChoice::Dev("http://localhost:5173".to_string()));
    }

    #[test]
    fn env_override_wins_even_in_release() {
        let choice = resolve_url_choice(
            Some("http://127.0.0.1:9999".to_string()),
            Some("http://localhost:5173".to_string()),
            false,
        );
        assert_eq!(choice, UrlChoice::Dev("http://127.0.0.1:9999".to_string()));
    }

    #[test]
    fn blank_values_fall_back_to_builtin() {
        assert_eq!(
            resolve_url_choice(Some("   ".to_string()), Some("  ".to_string()), true),
            UrlChoice::Builtin
        );
    }
}
