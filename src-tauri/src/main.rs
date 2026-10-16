// Windows / Android 双端入口。
//
// 桌面:直接调用 lib 里的 run()。
// Android:必须先展开 tauri 的 android_binding! 宏 —— 它会生成
//   Java_top_tfrstudio_dfae_tauri_MainActivity_* 这一组 JNI 符号,
//   没有它 Android 侧就没有入口函数,链接阶段必然失败。
//   参数与 tauri.conf.json 的 identifier / productName 严格对应:
//     · 第一段 = identifier 的命名空间部分 → top
//     · 第二段 = Tauri 生成的 Activity 名(默认 MainActivity)经 snake_case + 前缀 → main
//   identifier 一旦改动,这里的域段必须同步改。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "android")]
    tauri::android_binding!(top, main, dfae_tauri_lib::run, ::tauri::wry);

    dfae_tauri_lib::run()
}
