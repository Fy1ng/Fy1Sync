# Stream Syncer P0 prototype validation

验证日期: 2026-10-18. 本报告复用中断前已完成的实际运行和 `prototype/.evidence/` 证据. 编排器取消没有被当作原型测试结果. 状态来自原型自身的输出.

| Item | Status | 关键结果 |
| --- | --- | --- |
| electron-playback | FAIL | 两路 1080p60 媒体生成成功; Electron renderer 启动失败, exitCode 49 |
| ffmpeg-live-buffer | FAIL | 已找到真实 live; 16 次主解析均失败, 未取得媒体 URL, 缓冲 0 s |
| ytdlp-js-runtime | PARTIAL | Electron bundled Node 24.22.0 实际运行并被 yt-dlp 识别; 直播解析被认证拦截 |
| douyu-quickjs | PASS | QuickJS 实际解签, API code 0, 四次真实流 ffprobe exit 0 |

P0 的四项全通过门槛尚未满足, 不进入 P1. 所有本轮文件写入都在 `prototype/` 内, 未提交, 未推送, 未改开发计划或生产代码. 开始时父仓库已在 `stream-syncer` 分支, `Stream Syncer Claude/.gitignore` 已有修改, 本轮保留该修改.

运行环境: Windows 10 build 19045, 宿主 Node 24.15.0, npm 11.12.1. 本地直接依赖精确固定为 `electron@44.9.0`, `hls.js@1.7.3`, `quickjs-emscripten@0.32.0`, 传递依赖由 `package-lock.json` 固定. Electron 内含 Chromium 152.0.7977.167 和 Node 24.22.0. 使用任务给定的 ffmpeg/ffprobe, 版本 `N-120072-g11d1b71c31-20250703`.

十个原型 JavaScript 入口/模块的 `node --check` 均 exit 0, `npm ls --depth=0` 通过并确认上述固定版本. 原型没有 TypeScript 编译目标, 未运行未改动的主工程单测或 build. 实际运行验收及未验证项如下; 语法检查成功没有被计为播放或取流成功.

以下命令从 `Stream Syncer Claude/prototype/` 运行. 已安装的依赖和已生成媒体可以直接复用. 在新的本地副本安装时使用:

```powershell
npm ci --cache .cache/npm --registry https://registry.npmjs.org --no-audit --no-fund
npm run setup
```

`setup` 将 Electron 下载缓存及临时目录限制在本原型内. Electron 44.9.0 的 npm 包使用延迟二进制下载, 单独 `npm install` 成功不代表 `electron.exe` 已就绪. 初次默认 npm 缓存和 Electron 缓存尝试被目录权限拒绝, 改为本地 npm cache 和 `electron_config_cache` 后安装成功. 未安装任何全局包. `.gitignore` 忽略 `.media/`, `.runtime/`, `.cache/` 和 `node_modules/`; 原始签名 URL, 签名参数, 远端页面及私有日志只放在这些忽略目录内. 原型未创建 HTTP 服务或监听端口.

## 1. electron-playback

Status: FAIL. 媒体生成已实际通过, 但当前执行环境不能启动 sandboxed renderer, 双视频播放验收没有完成.

### How to run

```powershell
# 媒体不存在时生成, 当前副本已生成完成.
node electron-playback/generate.cjs
node electron-playback/run.cjs

# 已实际尝试的软件渲染诊断, 仍保持 sandbox=true.
$env:P0_SOFTWARE='1'
node electron-playback/run.cjs
Remove-Item Env:P0_SOFTWARE
```

主进程使用 `contextIsolation=true`, `sandbox=true`, `nodeIntegration=false`, 没有 preload 或对外 IPC. 在 app ready 前注册 privileged `stream://`, 设置 `standard`, `secure`, `supportFetchAPI`, `stream`, `corsEnabled`. UI 位于 `stream://app`, 媒体位于 `stream://media`, 媒体 CORS 仅允许 `stream://app`. 文件映射限制在 `.media/` 的规范路径和真实路径内, 支持单段 HTTP Range, 不转发远程请求.

渲染脚本同时加载两路 hls.js, 在 45 s 位置开始 30 s 测量, 收集每路 `requestVideoFrameCallback` 次数和递增 `mediaTime`, `getVideoPlaybackQuality` 前后差值, `drawImage` + `getImageData`, 再回退 30 s 并观察恢复播放 8 s. live 模式使用同一套探针, 回退 120 s, 还检查 hls.js 是否把回退位置追到 live edge. 这些是待运行的验收逻辑, 本轮没有把它们的存在当作通过证据.

### Evidence

生成命令的核心参数, 两路仅替换输入源和输出目录:

```text
ffmpeg.exe -hide_banner -y -f lavfi -i testsrc2=size=1920x1080:rate=60 -t 120 -an -c:v libx264 -preset ultrafast -threads 4 -pix_fmt yuv420p -b:v 4500k -maxrate 6000k -bufsize 9000k -g 360 -keyint_min 360 -sc_threshold 0 -f hls -hls_time 6 -hls_list_size 0 -hls_playlist_type vod -hls_flags independent_segments+temp_file -hls_segment_filename .media/testsrc2/segment-%03d.ts .media/testsrc2/index.m3u8
```

第二路输入为 `smptehdbars=size=1920x1080:rate=60`. 准确绝对路径命令记录在 [playback-generation.json](.evidence/playback-generation.json).

```text
ffprobe.exe -v error -show_entries stream=codec_name,width,height,r_frame_rate,avg_frame_rate:format=duration -of json .media/testsrc2/index.m3u8
```

| 生成/探测项目 | testsrc2 | smptehdbars |
| --- | --- | --- |
| ffmpeg / ffprobe exit | 0 / 0 | 0 / 0 |
| 分辨率 / codec | 1920x1080 / h264 | 1920x1080 / h264 |
| r_frame_rate / avg_frame_rate | 60/1 / 60/1 | 60/1 / 60/1 |
| duration | 120.000000 s | 120.000000 s |
| 分片 | 20 个, 每个 6 s | 20 个, 每个 6 s |
| 生成及探测 wall time | 5.934 s | 4.362 s |

实际启动命令由 `run.cjs` 执行, 不设置 `ELECTRON_RUN_AS_NODE`:

```text
node_modules/electron/dist/electron.exe electron-playback/main.cjs --disk-cache-dir=<prototype>/.runtime/cache
```

最终两次运行分别使用默认硬件路径和软件渲染, main exit 均为 1, wall time 分别为 0.253 s 和 0.252 s. 两次都观测到:

```text
Renderer exited: {"reason":"launch-failed","exitCode":49}
GPU process exited unexpectedly: exit_code=-1073741515
ERR_FAILED (-2) loading 'stream://app/index.html'
```

| 播放验收指标 | 本轮结果 |
| --- | --- |
| 完成的 renderer 测量 | 0 次 |
| 双视频开始播放 | 未观测 |
| 每路 frame callback 次数 / mediaTime 增量 | N/A, renderer 未启动 |
| 30 s total frames / dropped frames / dropped percent | N/A, 没有完成测量, 不能记为 0 掉帧 |
| Canvas drawImage + getImageData / taint | 未验证 |
| 回退 30 s 的落点 / 误差 / 恢复播放 | 未验证 |

证据: [playback-attempts.json](.evidence/playback-attempts.json), [playback-vod.json](.evidence/playback-vod.json).

### Problems

首跑被 Electron 安装目录读取 ACL 检查阻挡. 已仅对本原型 `node_modules/electron/dist` 的 76 个生成文件授予 `ALL APPLICATION PACKAGES` 读取/执行权限, `icacls` 返回成功 76, 失败 0; 仍不能通过该检查. 再仅对同一公共二进制目录授予 `Everyone` 读取/执行后, 安装目录检查通过, 随后复现上述 renderer 49. 未改外部目录 ACL. 硬件和软件渲染的复跑都保留 sandbox, 没有通过关闭安全配置改变验收条件.

已直接核验 [Chromium sandbox_types.h](https://github.com/chromium/chromium/blob/main/sandbox/win/src/sandbox_types.h): `49 = SBOX_ERROR_CANNOT_CREATE_RESTRICTED_TOKEN`. [Electron 的安装目录检查源码](https://github.com/electron/electron/blob/v44.9.0/shell/browser/win/install_dir_access.cc) 也表明首个错误来自 sandbox token 的读访问检查. renderer token 创建失败是当前执行环境的阻碍; GPU 错误原因未进一步证实. 这不是双路解码性能或 stream 协议不可行的证据.

### Recommendation for the real implementation

在能够正常创建 Chromium restricted token 的 Windows 前台执行环境, 保持相同安全配置运行本脚本, 补齐双路帧、画布、30 s 掉帧和 30 s 回退数据. 然后在实际硬件上评估 1080p60 双路解码; 本轮不能给出性能结论. 保留明确的媒体根路径, 固定 origin, CSP 和受限协议映射, 不将原型中的整文件同步读入内存方式直接推广到正式实现.

Final status: FAIL.

## 2. ffmpeg-live-buffer

Status: FAIL. 已发现真实直播, 但 YouTube 在当前网络出口要求认证, yt-dlp 没有返回媒体格式或可用 URL, 无法启动要求的实际直播缓冲.

### How to run

```powershell
$env:YTDLP_PATH=(Resolve-Path '.runtime/yt-dlp/yt-dlp.exe').Path
$env:YTDLP_NODE_RUNTIME=(Resolve-Path 'node_modules/electron/dist/electron.exe').Path
node ffmpeg-live-buffer/discover.mjs
node ffmpeg-live-buffer/run.mjs

# 取流成功后才可执行, 本轮未生成该 playlist.
node electron-playback/run.cjs live youtube-hls/index.m3u8
```

未设置 `YTDLP_PATH` 时沿用任务给定的已安装 yt-dlp. `YOUTUBE_LIVE_URL` 可指定当前公开 watch URL. 默认 `BUFFER_SECONDS=310`, P0 缓冲验证不得降到 300 s 以下. 启用 Electron runtime 时脚本只为 yt-dlp 子进程设置 `ELECTRON_RUN_AS_NODE=1`.

脚本包含实际缓冲循环和每 10 s 的 playlist 检查, 达到目标后向 ffmpeg 发送 `q` 并执行 ffprobe. 预备的缓冲命令如下, 本轮因没有 resolved URL 而未执行:

```text
ffmpeg.exe -hide_banner -y -rw_timeout 20000000 -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 10 -live_start_index -3 -i <resolved live HLS URL> -c copy -f hls -hls_time 2 -hls_list_size 90 -hls_flags delete_segments+append_list+program_date_time -hls_delete_threshold 1 -hls_segment_filename .media/youtube-hls/segment_%06d.ts .media/youtube-hls/index.m3u8
```

### Evidence

发现命令, 实际 exit 0:

```text
yt-dlp.exe --ignore-config --cache-dir <prototype>/.media/youtube-hls/ytdlp-cache --flat-playlist --dump-single-json --socket-timeout 20 --retries 1 "ytsearch10:live news 24/7"
```

2026-10-18 14:50:26 UTC 搜索的 10 个结果中, 以下三个明确返回 `live_status=is_live`:

| 直播 | 公开 URL / ID |
| --- | --- |
| Dateline 24/7 | https://www.youtube.com/watch?v=z0_NKzi57Fo |
| LiveNOW FOX 24/7 | https://www.youtube.com/watch?v=C96oohpWBGw |
| CNA 24/7 | https://www.youtube.com/watch?v=-PWMxjBgr0k |

主解析命令:

```text
yt-dlp.exe --ignore-config --cache-dir <prototype>/.media/youtube-hls/ytdlp-cache --no-playlist --no-progress --socket-timeout 20 --retries 1 --extractor-retries 1 --no-js-runtimes --js-runtimes "node:<runtime executable>" --dump-single-json <public live URL>
```

主解析累计 16 次, exit 全部为 1. 覆盖任务给定的 `2026.03.17`, 官方本地新版 `2026.08.19`, 宿主 Node 24.15.0 和 Electron Node 24.22.0. 新版六个候选复测中, 五个返回认证要求, 旧 Lofi ID 返回录播不可用. 还记录了旧版两次 `android_vr` / `web_safari` 替代客户端尝试, 均未取得媒体格式.

最新新版 + Electron Node 对 FOX 直播的运行返回:

```text
ERROR: Sign in to confirm ... not a bot
exitCode=1, classification=youtube_authentication_required
```

其他已尝试来源包括 `https://www.youtube.com/@lofigirl/live`, `https://www.youtube.com/@DWNews/live`. 前者识别到当前 ID `1-LpQekNa9g`, 后者识别到 `LuKwFajn37U`, 但完整取流都被认证拦截. 旧的 `jfKfPfyJRdk` 返回 `This live stream recording is not available`.

| 要求的指标 | 本轮结果 |
| --- | --- |
| 已成功获取的格式记录 | 0 |
| HLS 最大分辨率 / codec / bitrate | 未知, 解析未成功 |
| DASH 最大分辨率 / codec / bitrate | 未知, 解析未成功 |
| ffmpeg 真实直播运行时长 | 0 s, 未启动 |
| 本地 playlist 缓冲时长 / TS 分片 | 0 s / 0 个 |
| 滚动删除 / 稳定运行 >=5 min | 未验证 |
| Electron 播放及回退 120 s | 未运行, 没有真实直播 playlist |
| DASH video+audio pair copy mux | 未运行, 没有格式或 MPD |

格式记录 0 只说明本轮没有获取成功, 不能推断 YouTube 不提供 HLS/DASH. 实现会分别汇总 `protocol`, resolution, fps, codec, `tbr/vbr/abr`; DASH MPD 可用时用 ffprobe 选择 video/audio representation, 再运行 30 s copy mux 样本. 该路径没有运行证据.

证据: [youtube-search.json](.evidence/youtube-search.json), [youtube-buffer.json](.evidence/youtube-buffer.json), [youtube-client-probes.json](.evidence/youtube-client-probes.json). 准确命令及每次失败分类在这些文件中, 未使用 Cookie, 未修改全局 yt-dlp 或代理设置.

### Problems

当前阻碍为上游认证要求, 不能通过再次编译或生成合成媒体满足真实直播验证. 需要一个能够正常解析公开 YouTube 直播的执行/网络环境, 才能补齐格式、310 s 缓冲和 120 s 回退验收. 现有条件下没有依据确认 DASH 双流转封装兼容性.

### Recommendation for the real implementation

将认证要求、网络错误、直播不可用、JS runtime 和格式/codec 错误分别分类, 保留手动地址入口. 以实际 `EXTINF` 总时长管理三分钟保留窗口. `-c copy` 的切片受源关键帧间距限制, `-hls_time 2` 和 90 个分片不能保证 180 s. 对 DASH 的 H.264/AAC 和其他 codec 组合分别验证本地 HLS/MSE 兼容性, 在实测前不承诺最高画质均可 copy 播放.

Final status: FAIL.

## 3. ytdlp-js-runtime

Status: PARTIAL. Electron bundled Node 可以运行并被 yt-dlp 识别, 但真实 live 的成功解析和 JS challenge 执行尚未证实.

### How to run

```powershell
# 使用任务给定的 2026.03.17.
node ytdlp-js-runtime/run.cjs

# 官方新版已下载并校验, 直接复用.
$env:YTDLP=(Resolve-Path '.runtime/yt-dlp/yt-dlp.exe').Path
node ytdlp-js-runtime/run.cjs
Remove-Item Env:YTDLP
```

单独验证 bundled Node 的实际命令:

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& '.\node_modules\electron\dist\electron.exe' -p 'JSON.stringify(process.versions)'
```

真实 live 解析的实际命令, 在同一 `ELECTRON_RUN_AS_NODE=1` 子进程环境执行:

```powershell
$runtime=(Resolve-Path 'node_modules/electron/dist/electron.exe').Path
& '.\.runtime\yt-dlp\yt-dlp.exe' --ignore-config --cache-dir '.cache/yt-dlp-runtime' --no-js-runtimes --js-runtimes "node:$runtime" --no-remote-components --no-playlist --socket-timeout 15 --retries 0 --skip-download --dump-single-json --verbose 'https://www.youtube.com/watch?v=-PWMxjBgr0k'
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

`run.cjs` 只把此环境变量传给自身的探测子进程, 不改变调用者的后续 Electron GUI 启动环境.

### Evidence

| 检查 | 观测 |
| --- | --- |
| 已安装 yt-dlp --version | 2026.03.17 |
| 本地官方新版 --version | 2026.08.19 |
| Electron Node 探测 | exit 0, node=24.22.0, electron=44.9.0 |
| 两版 yt-dlp runtime 检测 | `[debug] JS runtimes: node-24.22.0` |
| 两版 challenge provider 注册 | `node` available |
| CNA live 完整解析 | 两版均 exit 1, formats 0 |
| 实际 JS challenge 执行 | 未观测到, `challengeExecution=false` |
| 失败边界 | player API `LOGIN_REQUIRED`, bot confirmation |
| 两版解析 wall time | 旧版最终 2.693 s, 新版 2.873 s |

`--help` 实际说明支持 `deno`, `node`, `quickjs`, `bun`, 优先级按这个顺序, 只有 Deno 默认启用. `--no-js-runtimes --js-runtimes node:<electron.exe>` 能明确只选择 Electron Node.

实时读取的 [yt-dlp EJS 官方文档](https://github.com/yt-dlp/yt-dlp/wiki/EJS) 列出当前 Node 最低支持版本为 22.0.0. [官方 README](https://github.com/yt-dlp/yt-dlp#dependencies) 要求 `yt-dlp-ejs` 和受支持 JS runtime 才有完整 YouTube 支持. 不能把 `node` 被检测到等同于 EJS challenge 已成功执行.

本地新版官方 Windows executable 的 verbose 输出包含 `yt_dlp_ejs-0.8.0`, 无需打开远程组件下载. 任务给定的 pip 版本的 optional library 列表没有 EJS, 本轮没有全局补装; 它在进入可观察的 challenge 执行前也被认证要求阻挡.

新版下载命令为 `NODE_USE_ENV_PROXY=1` 下执行 `node ytdlp-js-runtime/download-local.cjs`. 来源为 [官方 release 2026.08.19](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19), 发布于 2026-08-19. 下载 `yt-dlp.exe` 为 17,840,399 bytes, 与同一 release 的 `SHA2-256SUMS` 核对成功:

```text
SHA256 66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a
```

证据: [runtime-2026.03.17.json](.evidence/runtime-2026.03.17.json), [runtime-2026.08.19.json](.evidence/runtime-2026.08.19.json), [runtime-download.json](.evidence/runtime-download.json). 日志中的现有代理配置已脱敏, 原始 stdout/stderr 仅留在忽略目录.

### Problems

Electron Node 可执行性和 yt-dlp runtime 识别这两个子项实际成功. 由于 YouTube 认证拦截, 没有成功解析的 live 或完整 EJS challenge 输出, 因而不将本项记为 PASS. 当前官方要求和已检测到的版本相容, 但完整取流兼容性仍需运行验收.

### Recommendation for the real implementation

打包官方 yt-dlp executable 及其匹配 EJS, 显式指定 bundled Electron Node 路径, 并仅为 yt-dlp 子进程设置 `ELECTRON_RUN_AS_NODE=1`. 更新时同时检查 Electron Node 最低版本和 EJS 兼容性, 更新失败保留可用版本. 在能够成功解析的真实直播上补测 challenge 执行与 HLS/DASH 格式返回.

Final status: PARTIAL.

## 4. douyu-quickjs

Status: PASS, 范围为 live 解签、取流和 ffprobe 实际音视频包验证. 画质切换有效性属于下述独立限制.

### How to run

```powershell
$env:NODE_USE_ENV_PROXY='1'
node douyu-quickjs/run.mjs
```

`P0_DOUYU_ROOM` 可指定公开数字房间 ID, `P0_FFPROBE` 可覆盖 ffprobe 路径. 默认从 live directory 和 room API 验证直播状态. 远端 JavaScript 只由 QuickJS WASM 的 `evalCode` 执行, 未导入或使用 Node `vm`, 未暴露宿主函数或系统接口. 已知 `rid+did+timestamp+version` 的 MD5 在宿主预计算后作为字符串字面量替换, 不向远端脚本暴露 Node crypto.

### Evidence

实际运行于 2026-10-18 14:45:34-14:45:40 UTC. live directory, room API 和房间页面均 HTTP 200. 房间 `9999` 的 `room_status=1`, 从移动页面提取到 `ub98484234`, 在独立 QuickJS runtime 内解混淆, 再在另一个独立 runtime 内执行签名.

| Sandbox 检查 | 观测 |
| --- | --- |
| 每个 runtime 内存分配限制 | 16,777,216 bytes, 16 MiB |
| interrupt deadline / stack limit | 500 ms / 524,288 bytes |
| 无限循环 | `InternalError: interrupted`, 500.672 ms, 17,667 次 interrupt 检查 |
| 分配 32 MiB ArrayBuffer | `InternalError: out of memory`, 0.820 ms |
| process / require / fetch / XMLHttpRequest / WebSocket / console | 六个 `typeof` 均为 `undefined` |
| 解混淆输入 / 输出 | 19,599 / 1,800 bytes |
| Decode / sign wall time | 9.141 / 0.853 ms |
| Signed params | 103 bytes; keys `v,did,tt,sign,ver,rid,rate`, 值不进入报告 |

POST `https://m.douyu.com/api/room/ratestream`, HTTP 200, `code=0`. 实际返回 URL 的播放探测命令, 签名 URL 和现有代理地址不写入报告:

```text
ffprobe.exe -v error -http_proxy <existing proxy> -rw_timeout 15000000 -read_intervals %+3 -count_packets -show_entries stream=codec_type,codec_name,width,height,r_frame_rate,bit_rate,nb_read_packets:format=format_name,duration -of json <signed returned URL>
```

| Requested rate | API label | Returned rate | 实际视频 | 实际音频 | ffprobe |
| --- | --- | --- | --- | --- | --- |
| -1 | Default | 0 | H.264, 1280x720, 30/1 fps, 89 packets | AAC, 136 packets | exit 0, 1976.6 ms |
| 0 | 原画2K60 | 0 | H.264, 1280x720, 30/1 fps, 89 packets | AAC, 136 packets | exit 0, 763.5 ms |
| 3 | 超清 | 0 | H.264, 1280x720, 30/1 fps, 89 packets | AAC, 136 packets | exit 0, 760.5 ms |
| 2 | 高清 | 0 | H.264, 1280x720, 30/1 fps, 89 packets | AAC, 136 packets | exit 0, 761.8 ms |

这是四个 3 s read interval 的实际包级探测, 不是仅返回 URL 或编译成功. ffprobe format 为 `hls`, 未给出 bitrate, 不推测码率. 没有进行长期稳定性或 Electron 解码验收.

证据: [douyu-quickjs.json](.evidence/douyu-quickjs.json), [douyu-initial-failures.json](.evidence/douyu-initial-failures.json). 原始远端页面、解混淆代码、签名参数、取流响应和 expiring URL 只保存在已忽略的 `.media/douyu/`.

### Problems

默认 Node fetch 没有使用现有环境代理, 首次返回 `EACCES`. 用 Node 24 的 `NODE_USE_ENV_PROXY=1` 后成功, 未更改系统代理. 首次 ffprobe 按参考逻辑把 API 返回的 HTTP URL 自动升级为 HTTPS, 任务给定的 Schannel ffmpeg 构建返回 `Unable to acquire security credentials (0x8009030e)`, exit 1, 32.4 ms. 修复为保留 API 原始 HTTP URL后, 默认流和三档 rate 全部实际复跑通过. 未禁用 TLS 验证; 本轮验证了 HTTP 媒体, HTTPS 媒体仍未通过.

API 虽列出原画2K60、超清、高清三个标签, 所有请求均返回 `rate=0` 和实测 720p30. 本房间的 2K60 和有效切画质没有得到验证. 不能将标签直接展示为已确认的实际画质.

### Recommendation for the real implementation

保留每次全新 QuickJS runtime、内存和执行截止时间限制及完整 dispose. 本轮 16 MiB 是 QuickJS 分配限制, 不是 Node/WASM 总进程内存上限. 正式实现在隔离 worker 或 utility process 执行远端签名, 增加外部 watchdog 和总资源限制, 避免最坏 500 ms 同步执行阻塞 Electron 主进程. 对实际画质、返回 transport 和 CDN URL 校验分别建边界, 用实际媒体探测判断画质能力.

Final status: PASS.

## Decision inputs

- 保留 P0 四项全部 PASS 的开工门槛. 先在能创建 Chromium restricted token 的 Windows 前台环境补齐 item 1, 在能正常解析 YouTube live 的环境补齐 items 2/3; 当前不能批准 P1 开工.
- 明确区分 YouTube 认证拦截和 JS runtime 失败. 打包官方 yt-dlp/EJS, 核验当前 Node >=22 的要求, 仅给取流子进程设置 Electron Node 模式.
- 三分钟缓冲按实测 `EXTINF` 总时长控制, 不按 90 个分片假定 180 s; 补测 DASH 双流及不同 codec 的 copy mux/MSE 兼容性和回退后防自动追直播.
- 斗鱼移动 `ratestream` 的画质标签与实测能力分开. 桌面画质接口或有效切画质需要单独验证; 本轮三档都返回 720p30.
- QuickJS 的 16 MiB allocation cap 和 500 ms interrupt 不等于进程级硬限额. 正式签名执行隔离和 watchdog 的具体边界需纳入后续实现方案.
- 任务给定 ffmpeg 使用 `--enable-gpl --enable-version3`, 不能作为计划中已核验的 LGPL 分发构建. 另选符合分发方案的构建, 并验证其 TLS; 保留或明确分类 API 返回的 HTTP 媒体, 不静默升级所有 URL.

## Orchestrator re-run (2026-10-18, outside Codex sandbox)

**electron-playback: PASS.** `node electron-playback/run.cjs` from a normal user shell, same security settings (contextIsolation / sandbox on, nodeIntegration off). The item-1 FAIL above was caused by the Codex execution sandbox (Chromium `SBOX_ERROR_CANNOT_CREATE_RESTRICTED_TOKEN`), not by the design.

| | testsrc2 | smptehdbars |
| --- | --- | --- |
| rVFC callbacks in 30 s / mediaTime regressions | 1801 / 0 | 1800 / 0 |
| max frame gap | 16.7 ms | 16.7 ms |
| dropped frames during 30 s window | 0 / 1802 | 0 / 1801 |
| canvas drawImage + getImageData (1920x1080) | ok, not tainted | ok, not tainted |
| seek back 30 s: landing error / wall time | 0 s / 980 ms | 0 s / 152 ms |
| playback 8 s after seek | +8.000 s, resumed | +8.001 s, resumed |

GPU video decode enabled. One non-fatal hls.js `bufferStalledError` on smptehdbars, recovered.

**YouTube from the user shell:** same `Sign in to confirm you're not a bot` with yt-dlp 2026.08.19 + Electron Node. The block is on the network egress, not the sandbox. Items 2/3 need either browser cookies (`--cookies-from-browser`) or a different egress to proceed.

## P0b re-run with manual logins (2026-10-19, orchestrator, normal user shell)

Logins were done by hand in dedicated Chrome profiles (`npm run login -- youtube|douyu`, `--disable-sync`, no account auto sign-in). Edge was abandoned because a fresh Edge profile signs into the Windows Microsoft account and syncs extensions. Electron was abandoned for login because Google rejects sign-in in embedded browsers. Cookie files are user-only (`icacls` shows only the current user).

All four P0 items now pass.

### 2. ffmpeg-live-buffer: PASS

Source: live CS2 match, YouTube `KvotSW40t7w` (Thunderpick World Championship 2026), resolved with YouTube cookies.

| Check | Result |
| --- | --- |
| Formats offered | HLS only, 144p to **1080p60 H.264 at 5.55 Mbps** (format 301). `formats=dashy` returns no DASH either |
| ffmpeg `-c copy` run | 310 s wall time, stable, 2 s segments |
| Rolling window | grows to 90 segments = 180 s, then the oldest is dropped (sequence 0 → 66 at 310 s) |
| Electron playback of the live buffer (second run, 208 s seekable) | 1801 frame callbacks in 30 s, 0 regressions, 0 dropped frames, canvas 1920×1080 readable |
| Seek back 120 s | error 0 s, 274 ms, +7.92 s progress in the next 8 s, playback resumed, not pulled back to live |

The DASH copy-mux question is moot for this source: YouTube served no DASH for the live stream.

### 3. ytdlp-js-runtime: PASS

yt-dlp 2026.08.19 with `--js-runtimes node:<electron.exe>` and `ELECTRON_RUN_AS_NODE=1` logged `[jsc:node] Solving JS challenges using node` and returned formats. With cookies the bot check no longer triggers.

### 4. Douyu quality: needs the PC `getH5PlayV1` endpoint

The mobile `ratestream` endpoint returns 720p30 for every rate, logged in or not; it cannot switch quality. The PC endpoint `https://www.douyu.com/lapi/live/getH5PlayV1/<rid>` can (`douyu-quickjs/h5play-v1.mjs`). It runs **no remote JavaScript**: `getEncryption` returns a seed and the auth token is iterated MD5 (flow from streamlink PR #6959 and renmu123/biliLive-tools, 2026). Room 9999, H.264 FLV:

| rate | Logged in | Anonymous |
| --- | --- | --- |
| 0 原画 (蓝光 8.8M) | **2560×1440@60** | downgraded to rate 4: 1920×1080@30 |
| 4 蓝光4M | 1920×1080@30 | 1920×1080@30 |
| 3 超清 | 1280×720@30 | 1280×720@30 |
| 2 高清 | 960×540@25 | 960×540@25 |

So login is what unlocks the top quality. Streams are FLV, which the plan already routes through ffmpeg into the local HLS buffer.

## P0c: YouTube live 1440p (orchestrator, 2026-10-19)

Corrects the P0 finding "YouTube live is HLS only, max 1080p60". That holds only for formats
that need no PO Token. The `web` client also exposes live adaptive formats up to 1440p60
(VP9 308, AV1 400, ~9 Mbps) that require a GVS PO Token.

- Token: bgutil-ytdlp-pot-provider 2.0.2 in script mode (no listener; release zip SHA-256
  a26b980b...27ef verified), `--extractor-args "youtube:player_client=web;formats=incomplete"`.
  Logged-in cookies are still required; the token is bound to the video ID.
- Fetch: `youtube-dash/pull.mjs` reads video + audio by `sq` index (5 s segments). 330 s run:
  70/70 segments, 141/141 HTTP 200, 0 retries, 0 gaps, at most 2 segments behind the head.
- Mux: byte-concatenating the segments, then `ffmpeg -c copy` to fMP4 HLS, gives continuous
  timestamps (350 s, 0 gaps). Using ffmpeg's concat demuxer per segment does NOT: audio PTS jump.
- Playback (`youtube-dash/play/main.cjs`, Electron 44 + hls.js): VP9 and AV1 1440p both use
  D3D11VideoDecoder (hardware) on RX 6750 XT. The last round played 60 fps with 0 dropped frames
  for both. The first rounds of the same files dropped 17-37 frames/s; the cause is not known.
- Runtime: the whole chain also runs on Electron's own Node (44.9.0 / Node 24.22) with no system
  Node on PATH: `--js-runtimes node:<electron.exe>` + `ELECTRON_RUN_AS_NODE=1` on the yt-dlp child.
  bgutil spawns the same exe for token generation; canvas 3.2.3 is N-API and loads unchanged.
  No separate Node needs to be bundled.
