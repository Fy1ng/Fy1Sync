# Third-party notices for Fy1Sync local Windows x64 evaluation builds

CS2 schedule metadata is by [Liquipedia contributors](https://liquipedia.net/counterstrike/Liquipedia:Matches), under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Fy1Sync extracts match, team, tournament and stream fields from the MediaWiki API and supplies attribution with every schedule response. Cached metadata retains the same license. The offline fixture is a trimmed API response; its source and modifications are recorded in `server/esports/fixtures/README.md`.

Fy1Sync itself is Copyright (C) 2026 Fy1ng and is licensed under the GNU General Public License, version 3 or (at your option) any later version (`GPL-3.0-or-later`). The full text is `LICENSE` in the source repository and `licenses/Fy1Sync-LICENSE.txt` in the package. Third-party programs remain separate executables or provider resources, outside app.asar, with their own terms listed below.

Huya's minimal TarsV3 protocol implementation and golden request/response fixtures reference [biliup/biliup commit 48a0d234794bb918e211076b357823438e8c109d](https://github.com/biliup/biliup/tree/48a0d234794bb918e211076b357823438e8c109d), MIT, Copyright (c) 2019 ForgQi. The full notice is retained in `server/platforms/fixtures/huya-biliup-LICENSE.txt`; preserve it with redistributed implementations or fixture copies. No Simple Live code is included.

## Fixed runtime inputs

| Component | Fixed input | License and source |
| --- | --- | --- |
| Electron | 44.9.3 | MIT plus Chromium and other licenses. Keep LICENSE.electron.txt and LICENSES.chromium.html shipped by Electron. Source: https://github.com/electron/electron/tree/v44.9.3 |
| React, react-dom, scheduler, hls.js, parse5, entities, Undici, @tanstack/react-virtual and @tanstack/virtual-core | Exact installed production versions matching package-lock.json | Original LICENSE/COPYING/NOTICE files are copied under licenses/application-npm, with exact versions and source/integrity metadata in application-npm-dependencies.json. React packages, parse5, Undici and the TanStack Virtual packages use MIT, hls.js uses Apache-2.0, and entities uses BSD-2-Clause; retain their original copyright notices. The bundled network-runtime.cjs installs the locked Undici implementation in the app and Node helper processes. |
| Rust/WASM dependencies | Exact registry crate versions in Cargo.lock | Original license files are extracted from official crates.io source archives after checking their SHA256 against Cargo.lock. application-rust-dependencies.json records versions and source links. This includes locked build-time crates conservatively; it does not ship Rust tooling. |
| FFmpeg and ffprobe | Fy1Sync Windows x64 minimal shared build 8.1.3-5c4f5744cd-fy1sync.1, version n8.1.3-23-g5c4f5744cd-fy1sync.1 | LGPL-2.1-or-later, built by Fy1Sync from FFmpeg commit 5c4f5744cd60943125a78db692b728210102f255 without GPL, version3 or nonfree components. Matching source, patches, build scripts, configuration and hashes are included in the source archive and build-manifest.json. |
| FFmpeg native dependencies | Static zlib 1.3.2; GCC 14.2.0 runtime, MinGW-w64 12.0.0 runtime and winpthreads from the locked WinLibs toolchain | Original zlib, MinGW-w64 and winpthreads notices and GCC COPYING3/COPYING.RUNTIME are retained under licenses/ffmpeg. Windows Schannel and the system certificate store provide HTTPS, with server certificate verification enabled by the included FFmpeg patch. No OpenSSL or GnuTLS library is shipped for FFmpeg. |
| yt-dlp | Official Windows yt-dlp.exe 2026.10.21 | Official bundled executable is GPLv3+ because it incorporates third-party code. The Python project source alone being Unlicense does not make this executable Unlicense. Preserve source archive, LICENSE and third-party license information. https://github.com/yt-dlp/yt-dlp/tree/2026.10.21 |
| bgutil-ytdlp-pot-provider | 2.0.2, Python plugin and one-shot JavaScript provider | GPL-3.0-only. Full matching provider source is included. Only script-mode Python files are exposed to yt-dlp at runtime; no HTTP provider server is started. https://github.com/Brainicism/bgutil-ytdlp-pot-provider/tree/2.0.2 |
| Noto Sans SC | Variable wght, @fontsource-variable/noto-sans-sc 5.3.1 split files, renamed `Studio Sans` in CSS | SIL OFL 1.1, Copyright 2014-2021 Adobe, Reserved Font Name 'Source'. License: src/studio/fonts/noto-sans-sc/OFL.txt. Source: https://github.com/notofonts/noto-cjk |
| Barlow Semi Condensed | @fontsource/barlow-semi-condensed 5.3.0, weights 300-700, latin and latin-ext, renamed `Studio Figures` in CSS | SIL OFL 1.1, Copyright 2017 The Barlow Project Authors. License: src/studio/fonts/barlow-semi-condensed/OFL.txt. Source: https://github.com/jpt/barlow |
| 得意黑 Smiley Sans | v2.0.1, SmileySans-Oblique.ttf.woff2 unmodified, renamed `Studio Display` in CSS | SIL OFL 1.1, Copyright 2022-2024 atelierAnchor, Reserved Font Names Smiley and 得意黑. License: src/studio/fonts/smiley-sans/OFL.txt. Source: https://github.com/atelier-anchor/smiley-sans |

`tools-lock.json` records each download URL, exact length and SHA256. The preparation script copies the original license texts, FFmpeg build/version output and build manifest into `resources/tools/licenses/`, together with provider source, yt-dlp source and the unmodified FFmpeg source-and-build archive. The latter contains the original FFmpeg, zlib and MinGW-w64 source packages, preserving their per-file copyright notices, as well as the ordered patches, locked build inputs, scripts, configuration and validation evidence. The license texts and FFmpeg patches are also extracted under `licenses/ffmpeg/`. `provider-dependencies.json` records the exact npm package versions, SPDX declarations, registry source URLs and integrity values from the effective patched lock described below. Package license files in the provider's production dependencies are retained. No dependency install scripts run during preparation.

The provider's `canvas` dependency is removed before installation, so neither canvas nor its native libraries are shipped. Without canvas, jsdom's `getContext()` returns null; PO token generation was verified to be unaffected.

The provider source archive remains the unmodified upstream 2.0.2 source. This local build applies four production transitive dependency patches through `provider-dependency-patches.json` and a separately checked-in `provider-package-lock.json`: follow-redirects 1.16.0 -> 1.16.1, ip-address 10.7.3 -> 10.7.4, body-parser 2.3.0 -> 2.4.0 and Undici 7.30.0 -> 7.30.1. These address GHSA-q3jh-wrc6-jgq8, GHSA-8r9p-f939-6h3c, GHSA-rxp7-6hxx-x8q5, GHSA-27r3-jxmh-p828 and GHSA-xjj6-f33q-929c without modifying provider implementation. The packaged server contains the effective package.json/lock; the patch manifest and full original source are retained together. The final dependency index describes the patched build, not an unmodified upstream dependency installation. The separate Electron update addresses GHSA-jr5w-w6x2-84p9 and is recorded in the runtime table above.

## Source and availability boundaries

The matching FFmpeg runtime, source-and-build archive and build manifest are fixed assets of the Fy1Sync Release `ffmpeg-8.1.3-fy1sync.1`. Preserve the verified local `.packaging/downloads/` cache. Preparation can first copy identical assets from `.packaging/ffmpeg-build/out/8.1.3-5c4f5744cd-fy1sync.1/`; otherwise it uses only the locked Release URLs. Anonymous downloads will fail while the repository is private, so a local build or verified cache is required in that case. An unavailable locked asset makes preparation fail; it must never silently select another build.

The build manifest records the source, toolchain, dependency and patch identities, full configuration and runtime file hashes. The source archive contains the corresponding FFmpeg modifications and rebuild materials, including the original native dependency notices. Users may replace compatible shared FFmpeg libraries to debug their modifications, subject to the included licenses; preparation and packaging integrity checks do not impose an application runtime restriction on such replacement. The build identity and validation evidence do not claim byte-for-byte reproducibility across different build paths or machines. These unsigned artifacts remain local evaluation builds; public release acceptance is a separate step.

## Manual yt-dlp updates

An explicitly requested update uses only the official stable GitHub release, fixed `yt-dlp.exe` and `SHA2-256SUMS` assets, HTTPS and a bounded GitHub/CDN host allowlist. SHA256 checks detect corruption and mismatch; hashes fetched from the same official origin are not an independent publisher signature. New executable versions live in userData and do not overwrite the bundled executable. Keep the corresponding source and license information from the selected official release when redistributing an updated executable. Provider updates require an application package update in this first version.

FFmpeg reference: https://ffmpeg.org/legal.html

Build references: packaging/ffmpeg/README.md, scripts/build-ffmpeg.mjs and https://www.electron.build/nsis.html


## 摄像头 WebGPU 超分

以下代码和权重均按固定提交手工移植为 WGSL, 仅用于摄像头小窗. 中间纹理为 rgba16float.

### AMD FSR 1 EASU / RCAS

来源: [agyild FSR.glsl mpv hook](https://gist.github.com/agyild/82219c545228d70c5604f865ce0b0ce5/f1794d720013ccd9c5c86a0f20fddd71e0375f94), revision `f1794d720013ccd9c5c86a0f20fddd71e0375f94`; RGB 算法参考 [AMD ffx-fsr/ffx_fsr1.h](https://github.com/GPUOpen-Effects/FidelityFX-FSR/blob/a21ffb8f6c13233ba336352bdff293894c706575/ffx-fsr/ffx_fsr1.h), commit `a21ffb8f6c13233ba336352bdff293894c706575`. 对应 `src/media/upscale/fsr.ts`, RCAS 固定为 0.2 stops.

```text
Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### WebSR 真人/3D 重训权重

来源: [sb2702/websr](https://github.com/sb2702/websr/tree/a756eb82ec7d95553bded6bbd669d85bf2b288ff), commit `a756eb82ec7d95553bded6bbd669d85bf2b288ff`, `weights/anime4k/cnn-2x-s-rl.json` 和 `cnn-2x-m-rl.json`. [权重说明](https://github.com/sb2702/websr/blob/a756eb82ec7d95553bded6bbd669d85bf2b288ff/weights/anime4k/README.md) 标明 real-life retraining. 对应 `src/media/upscale/anime4k.ts` 的 typed Float32Array 数值, 默认使用 M. 仓库 MIT 许可原文如下.

```text
MIT License

Copyright (c) 2023 Sam Bhattacharyya

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Anime4K CNN-2x mpv 图结构

来源: [bloc97/Anime4K](https://github.com/bloc97/Anime4K/tree/7684e9586f8dcc738af08a1cdceb024cc184f426), commit `7684e9586f8dcc738af08a1cdceb024cc184f426`, `glsl/Upscale/Anime4K_Upscale_CNN_x2_S.glsl` 和 `Anime4K_Upscale_CNN_x2_M.glsl`. 对应 `src/media/upscale/anime4k.ts` 的卷积, CReLU 与 depth-to-space 图. 仓库许可及 shader 的版权行一并保留.

```text
MIT License

Copyright (c) 2019 bloc97
Copyright (c) 2019-2021 bloc97
All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
