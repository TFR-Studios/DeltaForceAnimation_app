/* ============================================================================
 * 内置静态 HTTP 服务(对应 electron/main.cjs 的 createStaticServer / startStaticServer)
 *
 * 为什么必须保留这一层(而不是直接用 tauri:// 或 file:// 加载):
 *   1) src/main.ts 里到处都是 fetch() / HEAD(按需拉动画 JSON、读 Content-Length 算进度),
 *      file:// 下相对资源会被 CORS 拦、fetch 直接失败;
 *   2) 导出用的 WebCodecs 只在**安全上下文**里可用 —— http://127.0.0.1:<随机端口> 是安全上下文,
 *      tauri://localhost / file:// 不是。
 *
 * 资源从哪来(这里踩过一次坑,记下来免得重犯):
 *   Tauri 在**构建期**就把 dist/ 编进了 exe(target/release 下根本没有 dist 目录),
 *   所以生产环境不能去磁盘上找 dist —— 必须走 app.asset_resolver(),它同时覆盖两种情形:
 *     · 生产:返回编进 exe 的前端产物;
 *     · 开发(debug + devUrl):回退成直接读 frontendDist 目录。
 *   极少数情况(没编进 exe 又确实有 dist 目录)再退回文件系统,由 FsAssets 兜底。
 *
 * 实现用 tiny_http:一个只有 HTTP 解析 + 线程分发的小 crate(约 4k 行),
 * 路由、MIME、Range、缓存头全部由本文件自己控制 —— 没有体量不可控的黑盒插件。
 * ========================================================================== */
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::thread;

use tiny_http::{Header, Method, Response, Server, StatusCode};

/* ---------------------------------------------------------------------------
 * 资源来源抽象
 * ------------------------------------------------------------------------- */

/** 一份可直接返回的资源。 */
pub struct AssetData {
    pub bytes: Vec<u8>,
    pub mime: String,
}

/**
 * 站点资源来源。生产走 Tauri 内嵌资源,开发/兜底走文件系统 ——
 * 两条路给上层同一个接口,httpd 不关心资源到底在哪。
 */
pub trait Assets: Send + Sync + 'static {
    /** path 是不带前导斜杠的站点相对路径(例:index.html、assets/x.js、animations/a/b.png)。 */
    fn get(&self, path: &str) -> Option<AssetData>;

    /**
     * 资源是否**真的**存在。
     *
     * 这个方法是必需的,不能拿 get().is_some() 代替:
     * Tauri 的 AssetResolver 自带三层回落(path → path.html → path/index.html → index.html),
     * 于是 get("不存在.js") 也会返回 index.html 的内容 —— 那样资源缺失会被伪装成 200,
     * 排障时看不到任何异常(Electron 版的 resolveSiteFile 刻意不做这个回落)。
     */
    fn exists(&self, path: &str) -> bool;

    /** 排障用:资源到底来自哪里。 */
    fn origin_desc(&self) -> String;
}

/** 走 Tauri 的资源解析器(生产:exe 内嵌;开发:frontendDist 目录)。 */
pub struct TauriAssets<R: tauri::Runtime> {
    resolver: tauri::AssetResolver<R>,
}

impl<R: tauri::Runtime> TauriAssets<R> {
    pub fn new(resolver: tauri::AssetResolver<R>) -> Self {
        Self { resolver }
    }
}

impl<R: tauri::Runtime> Assets for TauriAssets<R> {
    fn get(&self, path: &str) -> Option<AssetData> {
        let asset = self.resolver.get(path.to_string())?;
        Some(AssetData {
            bytes: asset.bytes,
            mime: asset.mime_type,
        })
    }

    fn exists(&self, path: &str) -> bool {
        /* 为什么要用一个不存在的哨兵路径做探针:
         * Tauri 的 AssetResolver::get 带三层回落(path → path.html → path/index.html → index.html),
         * 对任意路径都会返回 Some —— 直接 get().is_some() 等于恒真。
         * 哨兵 <name>.html 一定不存在(构建产物里没有把 .html 再套一层 .html 的文件),
         * 它的 get() 结果:
         *   · None      → 说明实现没做回落,用 None 判定即可;
         *   · 与 index.html 的内容一致 → 说明做了回落,此时「返回内容 == index.html 内容」就是回落标志。 */
        const SENTINEL: &str = "__dfae_probe__.html";
        if self.resolver.get(SENTINEL.to_string()).is_none() {
            return self.resolver.get(path.to_string()).is_some();
        }
        if path == "index.html" {
            return true;
        }
        match (
            self.resolver.get(path.to_string()),
            self.resolver.get("index.html".to_string()),
        ) {
            (Some(asset), Some(index)) => asset.bytes != index.bytes,
            _ => false,
        }
    }

    fn origin_desc(&self) -> String {
        "tauri-asset-resolver(生产环境为 exe 内嵌资源)".to_string()
    }
}

/** 从磁盘目录读(开发态或没有内嵌资源时的兜底)。 */
pub struct FsAssets {
    root: PathBuf,
}

impl FsAssets {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn resolve(&self, path: &str) -> Option<PathBuf> {
        let target = self
            .root
            .join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !is_inside(&self.root, &target) {
            return None; // 防 ../ 目录穿越
        }
        if target.is_file() {
            Some(target)
        } else {
            None
        }
    }
}

impl Assets for FsAssets {
    fn get(&self, path: &str) -> Option<AssetData> {
        let target = self.resolve(path)?;
        let bytes = fs::read(&target).ok()?;
        let ext = target
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        Some(AssetData {
            bytes,
            mime: mime_of(&ext).to_string(),
        })
    }

    fn exists(&self, path: &str) -> bool {
        self.resolve(path).is_some()
    }

    fn origin_desc(&self) -> String {
        format!("文件系统:{}", self.root.display())
    }
}

/* ---------------------------------------------------------------------------
 * MIME / 路径 / Range 工具
 * ------------------------------------------------------------------------- */

/* 与 electron/main.cjs 的 MIME 表逐项对齐:差一项就可能让浏览器把资源当成 octet-stream,
 * 音频/字体这类按 MIME 决定能不能播的资源会静默失效。
 * 注:Tauri 内嵌资源自带 mime_type,这里的表主要给 FsAssets 与 404/416 用。 */
fn mime_of(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "avi" => "video/x-msvideo",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes())
        .expect("内置 HTTP 服务的响应头名/值都是 ASCII 常量,构造失败属于编程错误")
}

/** 目标路径是否真的落在站点根目录内(防 ../ 目录穿越)。 */
fn is_inside(root: &Path, target: &Path) -> bool {
    target == root || target.strip_prefix(root).is_ok()
}

/** 解 %XX 转义(中文目录名/文件名在 URL 里就是这种形式)。 */
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

struct ByteRange {
    start: u64,
    end: u64,
}

/**
 * 解析 Range 头(音频试听/视频预览会带)。
 * Ok(None) = 按整文件响应;Err(()) = 416(区间非法)。
 */
fn parse_range(header_value: Option<&str>, size: u64) -> Result<Option<ByteRange>, ()> {
    let raw = match header_value {
        Some(v) => v.trim(),
        None => return Ok(None),
    };
    let spec = match raw.strip_prefix("bytes=") {
        Some(s) => s.trim(),
        None => return Ok(None), // 不认识的单位:宽容处理成整文件响应
    };
    let mut parts = spec.splitn(2, '-');
    let first = parts.next().unwrap_or("").trim().to_string();
    let second = parts.next().unwrap_or("").trim().to_string();
    if first.is_empty() && second.is_empty() {
        return Ok(None);
    }
    if first.is_empty() {
        let suffix: u64 = second.parse().map_err(|_| ())?;
        if suffix == 0 || size == 0 {
            return Err(());
        }
        return Ok(Some(ByteRange {
            start: size - suffix.min(size),
            end: size - 1,
        }));
    }
    let start: u64 = first.parse().map_err(|_| ())?;
    let end: u64 = if second.is_empty() {
        size.saturating_sub(1)
    } else {
        second.parse().map_err(|_| ())?
    };
    if size == 0 || start >= size || start > end {
        return Err(());
    }
    Ok(Some(ByteRange {
        start,
        end: end.min(size - 1),
    }))
}

/**
 * 把请求路径映射成站点内相对路径(与 electron/main.cjs 的 resolveSiteFile 同规则):
 *   · 目录/空 → index.html;
 *   · 带扩展名且不存在 → None(真 404)。绝不能回落 index.html,否则资源缺失会被伪装成 200;
 *   · 不带扩展名且不存在 → 回落 index.html(单页应用的客户端路由容错)。
 */
fn resolve_site_path(assets: &dyn Assets, url_path: &str) -> Option<String> {
    let decoded = percent_decode(url_path);
    let rel = decoded.trim_start_matches('/').to_string();
    let candidate = if rel.is_empty() {
        "index.html".to_string()
    } else {
        rel.clone()
    };
    if candidate.contains("..") {
        return None;
    }
    if assets.exists(&candidate) {
        return Some(candidate);
    }
    if let Some(rest) = candidate.strip_suffix('/') {
        let with_index = format!("{rest}/index.html");
        if assets.exists(&with_index) {
            return Some(with_index);
        }
    }
    if Path::new(&rel).extension().is_none() && assets.exists("index.html") {
        return Some("index.html".to_string());
    }
    None
}

/* ---------------------------------------------------------------------------
 * 请求处理
 * ------------------------------------------------------------------------- */

fn handle_request(req: tiny_http::Request, assets: &'static dyn Assets) {
    let method = req.method().clone();
    if method != Method::Get && method != Method::Head {
        let _ = req.respond(
            Response::from_string("method not allowed")
                .with_status_code(StatusCode(405))
                .with_header(header("Content-Type", "text/plain; charset=utf-8"))
                .with_header(header("Allow", "GET, HEAD")),
        );
        return;
    }

    let raw_url = req.url().to_string();
    let path_only = raw_url.split('?').next().unwrap_or("/").to_string();

    let site_path = match resolve_site_path(assets, &path_only) {
        Some(p) => p,
        None => {
            let _ = req.respond(
                Response::from_string(format!("404 {path_only}"))
                    .with_status_code(StatusCode(404))
                    .with_header(header("Content-Type", "text/plain; charset=utf-8")),
            );
            return;
        }
    };
    let asset = match assets.get(&site_path) {
        Some(a) => a,
        None => {
            let _ = req.respond(
                Response::from_string("asset read failed")
                    .with_status_code(StatusCode(500))
                    .with_header(header("Content-Type", "text/plain; charset=utf-8")),
            );
            return;
        }
    };

    let ext = Path::new(&site_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = if asset.mime.is_empty() {
        mime_of(&ext).to_string()
    } else {
        asset.mime
    };
    let size = asset.bytes.len() as u64;
    /* 带指纹的产物(/assets/xxx-<hash>.png)可以长缓存;入口文件必须每次校验,
     * 否则用户改了 dist 重新打开还是旧界面。 */
    let cache_control = if path_only.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };

    let range_header = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());
    let range = match parse_range(range_header.as_deref(), size) {
        Err(()) => {
            let _ = req.respond(
                Response::empty(StatusCode(416))
                    .with_header(header("Content-Type", &mime))
                    .with_header(header("Accept-Ranges", "bytes"))
                    .with_header(header("Cache-Control", cache_control))
                    .with_header(header("Content-Range", &format!("bytes */{size}"))),
            );
            return;
        }
        Ok(r) => r,
    };

    /* 资源已经在内存里(内嵌或刚读进内存),所以这里按切片返回,不再有磁盘 IO 与 seek。
     * Content-Length 由 tiny_http 依据 data_length 自动写出 —— 站点靠它算加载进度,必须准。
     * HEAD 用长度恰为 0 的 reader:状态码与 Content-Length 保持真实值,但不发 body。 */
    let (body, status, content_range) = match &range {
        Some(r) => {
            let start = r.start as usize;
            let end = r.end as usize;
            (
                asset.bytes[start..=end].to_vec(),
                StatusCode(206),
                Some(format!("bytes {}-{}/{size}", r.start, r.end)),
            )
        }
        None => (asset.bytes.clone(), StatusCode(200), None),
    };

    let mut headers = vec![
        header("Content-Type", &mime),
        header("Accept-Ranges", "bytes"),
        header("Cache-Control", cache_control),
    ];
    if let Some(cr) = content_range {
        headers.push(header("Content-Range", &cr));
    }

    /* chunked_threshold 默认 32KB:超过就改用 chunked 传输,而 chunked 响应没有 Content-Length ——
     * 站点正是靠 Content-Length 算「加载了多少」的(Electron 版也是显式给出这个头),
     * 所以这里把阈值抬到 usize::MAX,强制永远用 Content-Length。
     * HEAD 分支的真实长度也已经写进 Content-Length 头(tiny_http 会把该头转成 data_length)。 */
    let (reader, data_length): (Box<dyn Read + Send>, Option<usize>) = if method == Method::Head {
        headers.push(header("Content-Length", &size.to_string()));
        (Box::new(std::io::empty()), Some(0))
    } else {
        let length = body.len();
        (Box::new(std::io::Cursor::new(body)), Some(length))
    };
    let response = Response::new(status, headers, reader, data_length, None)
        .with_chunked_threshold(usize::MAX);
    let _ = req.respond(response);
}

/**
 * 启动内置服务:绑定 127.0.0.1 的**随机空闲端口**(端口 0 交系统分配),
 * 返回站点 origin(例 http://127.0.0.1:54321)。
 * 只监听回环地址 —— 局域网里其它机器访问不到,与 Electron 版一致。
 */
pub fn start(assets: Box<dyn Assets>) -> std::io::Result<(String, thread::JoinHandle<()>)> {
    let assets: &'static dyn Assets = Box::leak(assets);
    let server = Server::http("127.0.0.1:0").map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            format!("内置服务绑定失败: {e}"),
        )
    })?;
    /* 只监听回环地址,所以这里一定是 IP 形态;端口由系统分配(绑定时的端口 0)。 */
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
    };
    let origin = format!("http://127.0.0.1:{port}");
    let handle = thread::spawn(move || {
        for request in server.incoming_requests() {
            handle_request(request, assets);
        }
    });
    Ok((origin, handle))
}
