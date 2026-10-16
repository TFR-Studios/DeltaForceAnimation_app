// Tauri 构建脚本:读取 tauri.conf.json、生成 Windows 资源(图标/清单)、编译权限 schema。
//
// 另外在这里**自己声明并设置**项目级的平台 cfg:
//   dfae_desktop —— Windows / macOS / Linux
//   dfae_mobile  —— Android / iOS
//
// 为什么不直接用 tauri-build 的 desktop/mobile:
//   Cargo 的 [target.'cfg(...)'.dependencies] 表里的 cfg **不包含** build script 通过
//   cargo:rustc-cfg 设置的自定义 cfg(Cargo 解析依赖图时还没有运行 build script)。
//   一旦把 tiny_http / rfd 这类依赖写进 [target.'cfg(desktop)'.dependencies],
//   就会报 "unresolved import tiny_http" —— 桌面端反而编译不过。
//   所以:依赖表用**标准** cfg(见 Cargo.toml),代码里用下面这两个项目级 cfg。
fn main() {
    println!("cargo:rustc-check-cfg=cfg(dfae_desktop)");
    println!("cargo:rustc-check-cfg=cfg(dfae_mobile)");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android")
        || std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios")
    {
        println!("cargo:rustc-cfg=dfae_mobile");
    } else {
        println!("cargo:rustc-cfg=dfae_desktop");
    }
    tauri_build::build()
}
