# vgmstream 内置解码组件 · 第三方声明

本目录是随桌面端一起分发的 vgmstream 官方 Windows 构建，仅以独立子进程（vgmstream-cli.exe）
方式调用，用于把游戏内音频容器（.wem 等）解码为 PCM16 WAV 供试听/转码。

## vgmstream

- 版本：r2168（构建日期 2026-10-25，JSON/CLI 输出为 `r2168`）
- 来源：https://github.com/vgmstream/vgmstream/releases/tag/r2168
- 下载产物：`vgmstream-win64.zip`
- 压缩包 SHA-256：`692d45070852a35c1fa42726aa3c9de528e44eec925d37d99b1074256b99a229`
- 版权与许可：见同目录 `COPYING`。该许可允许以任何目的使用、复制、修改和分发，
  前提是保留版权声明与许可声明；本目录已完整保留 `COPYING`。
- 上游文档：`README.md`、`USAGE.md` 为官方压缩包内原文件。

## 运行时文件（SHA-256）

| 文件 | SHA-256 |
| --- | --- |
| vgmstream-cli.exe | `10fb0691538d3133f0115a071f89775fc99f32210b7e5991cfc3c2869247e4b2` |
| avcodec-vgmstream-63.dll | `047342e36b7f50c9d64e72a9b4b1b18df86e2fc32d6095a189ca361699df166f` |
| avformat-vgmstream-63.dll | `6011518f5614582f14fc412fbf2d5192317b0586bcb8adfe1995320cb7227a0b` |
| avutil-vgmstream-61.dll | `216ccd7ed4dbe224219420eff7d05f62adf1e94105eeaf3b2b6df8a63085caa0` |
| swresample-vgmstream-7.dll | `6de31a1b0caf676a6ebffceb9f540232db312773e97108cd93967e8a280da96e` |
| libcelt-0061.dll | `542254723d9100f91cbf18e41c4aff80287c22a9859e9e545c413d984df440ad` |
| libcelt-0110.dll | `bfcc51d865bb3b6a2793381bf535f23ec423feb722b46333fa8556ccdcafa61a` |
| libmpg123-0.dll | `018e6833088b3fc7d9a97c3f45abb5f9f947f7c46de4f17fddf423f430fa70fa` |
| libspeex-1.dll | `04dbc85fcec6c54671535bf39937a70f2dd040a81ad670a0b84de6ca17b39bff` |
| libvorbis.dll | `5f330a20b19b3c70dc43eedcc95891e65940fca04a77155c573efcdd4c2ca665` |

## 第三方组件

以下组件由官方构建以**独立 DLL 动态链接**方式提供，本仓库未修改其二进制、未做静态链接：

| DLL | 组件 | 许可 |
| --- | --- | --- |
| avcodec / avformat / avutil / swresample | FFmpeg n9.0.2（FFmpeg Project） | LGPL-2.1-or-later（DLL 内自带 "libavutil license: LGPL version 2.1 or later"） |
| libvorbis.dll | libvorbis（Xiph.Org） | BSD-3-Clause |
| libspeex-1.dll | Speex（Xiph.Org） | BSD-3-Clause |
| libmpg123-0.dll | mpg123 | LGPL-2.1-or-later |
| libcelt-0061.dll / libcelt-0110.dll | CELT（Xiph.Org） | BSD（Xiph.Org） |

FFmpeg 的 LGPL-2.1 全文已随附于 `LICENSES/FFmpeg-COPYING.LGPLv2.1.txt`。
其余组件的许可文本可从各自上游项目获取；若后续需要更严格的合规清单，可在
`LICENSES/` 下补齐对应全文。

## 再分发注意

- 请勿删除 `COPYING`、本文件以及 `LICENSES/` 目录。
- vgmstream 仅解码，不包含任何游戏音频素材；仓库内的样例音频只用于本地测试，未随包分发。
