# ffmpeg-live-buffer

这是 P0 的独立验证脚本. 它仅使用公开 YouTube URL, 不读取 Cookie, 不提供代理服务, 不监听端口.

从 `Stream Syncer Claude` 目录运行:

```powershell
node prototype/ffmpeg-live-buffer/discover.mjs
$env:YTDLP_PATH = (Resolve-Path -LiteralPath 'prototype/.runtime/yt-dlp/yt-dlp.exe').Path
$env:YTDLP_NODE_RUNTIME = (Resolve-Path -LiteralPath 'prototype/node_modules/electron/dist/electron.exe').Path
node prototype/ffmpeg-live-buffer/run.mjs
```

未设置 `YTDLP_PATH` 时使用任务给定的全局可执行文件. 未设置 `YTDLP_NODE_RUNTIME` 时使用当前 Node 可执行文件. `run.mjs` 发现 Electron runtime 时自动给 yt-dlp 子进程设置 `ELECTRON_RUN_AS_NODE=1`. 也可设置 `YOUTUBE_LIVE_URL` 为一个当前 live 的公开 watch URL. `BUFFER_SECONDS` 默认 310, 正式 P0 验证不得低于 300.

脚本先解析直播与全部格式, 再以 `-c copy`, `-hls_time 2`, `-hls_list_size 90`, `-hls_flags delete_segments+append_list+program_date_time` 转成本地 HLS. 每 10 s 记录时长, 分片数量和媒体序号, 310 s 后通过 `q` 正常结束 ffmpeg, 最后运行 ffprobe. 如果提供 DASH MPD 和视频/音频对, 先用 ffprobe 选择对应流索引, 再进行 30 s copy mux 样本.

脱敏证据在 `prototype/.evidence/youtube-buffer.json` 和 `youtube-search.json`. 原始解析数据与 ffmpeg 日志在已忽略的 `prototype/.media/youtube-hls/`. 原始 URL 不进入报告. 本地 HLS 成功生成后, 使用证据的 `hls.playlistRelative` 传给 Electron playback 原型, 再验证回退 120 s.

当前实跑的解析阶段被 YouTube 的 `Sign in to confirm you are not a bot` 拦截. 已升级本地 yt-dlp 后复测. 没有取到媒体 URL, 因此不把脚本检查通过当作直播缓冲通过, 未运行的 ffmpeg/播放/回退指标记为未验证.

实际分片时长取决于源的关键帧间距. 使用 `-c copy` 时 `-hls_time 2` 不能强制每 2 s 产生关键帧, `90` 个分片不必然等于 `180` s. 正式实现应基于实测 `EXTINF` 总时长控制时间窗口.
