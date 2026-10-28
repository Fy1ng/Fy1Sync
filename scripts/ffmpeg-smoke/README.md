# FFmpeg 本地冒烟

仅在 Windows 运行. 被测 runtime 与 fixture 生成器分离, 子进程清空代理并使用隔离的 APPDATA/TEMP. 不访问外部站点或系统证书库, 不安装证书. 本地服务仅监听 127.0.0.1.

```powershell
node scripts/ffmpeg-smoke/run.mjs --runtime-dir C:/fy1-ffmpeg-build/<build-id>/runtime --work-dir .runtime-cache/codex-ffmpeg-build-<new-id>/smoke --openssl C:/path/to/openssl.exe --fixtures-dir C:/path/to/media-fixtures
```

工作目录必须不存在, 且位于新的 `.runtime-cache/codex-ffmpeg-build-*` 下. `--openssl` 必须显式指定. 可以将 `--fixtures-dir` 换成 `--full-fixture-ffmpeg C:/path/to/ffmpeg.exe`, 使用有 libx264/libvpx-vp9/libaom-av1/AAC/PNG 编码器的独立完整版生成合成测试材料. 生成器与 OpenSSL 不作为发布运行时的依赖或可复现构建输入.

现成 fixture 目录应含 `official.mp4` (H264/AAC), `av.ts`, `av.flv`, `video.mp4` (H264), `audio.mp4` (AAC), `vp9.webm`, `av1.mp4`, `gifframes/frame-0001.png` 起的连续 PNG 序列, `hls/index.m3u8` 和相对路径 TS 分片. 媒体会复制到新工作目录并记录 size/SHA256, 不复制证书. 不接受链接文件, 不覆盖既有输出.

19 项检查包括版本, LGPL 2.1+, TLS 默认值, MP4 probe, PNG->GIF, HTTP TS/FLV/HLS 转 HLS, TS 转 fMP4, H264/VP9/AV1 视频 stdin 与 AAC Windows named pipe 转 fMP4, 以及所有输出的 JSON probe. GIF 验证头部, 尺寸, 多帧结构, 子块边界及 trailer. AV1 测试是 packet copy, 不证明像素解码能力.

TLS 矩阵不传 tls_verify: 入口, 子清单, 分片, AES key 和 HTTP->HTTPS 重定向分别直连和通过本地 HTTP CONNECT 代理. 每例必须非超时失败, 出现证书错误, HTTPS 服务收到零个 HTTP 请求, 代理例必须实际建立 CONNECT. HTTP 直连/代理对照必须成功. 自签证书每次新生成, 仅存于新工作目录.

`args.mjs` 是 944ba97 的 buildFfmpegArgs/hlsOutput 所需参数子集快照, 不读取或改写产品代码. 输出 `summary.json`, `results.json`, `fixtures.json`, `network.json`, `gif.json` 和每次命令的 stdout/stderr. 任一断言失败时退出非零.
