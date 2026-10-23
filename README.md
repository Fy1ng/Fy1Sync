# Stream Syncer

把官方赛事纯净流和国内解说流对到同一个时间点: **官方画面 + 解说声音 + 弹幕叠加**.

同一场比赛, 官方源画质好但没有解说, 国内直播有解说但通常慢十几秒. 应用同时播放两路视频, 识别画面中的倒计时跳秒, 估算并应用延迟差.

当前为 Electron + React + Rust/WASM 桌面工作副本, 已接入 ffmpeg 本地循环缓冲, 平台取流, 独立 Chrome 登录, 自动/手动同步和可选 YouTube 自适应高画质. P7 增加 Windows x64 用户级 NSIS/免安装 ZIP 的本地构建和手动 yt-dlp 更新. Windows 为主要验证平台, macOS / Linux 尚未验收. 本地回归与真实平台验收分别记录, P0 原型证据不能替代正式应用验收. 完整阶段计划见 [docs/plan.md](docs/plan.md).

## 快速开始

需要 Node.js >=22.12, npm, Rust 工具链及 `wasm32-unknown-unknown` target. 构建脚本使用固定版本的 wasm-bindgen, 缺少本地工具时通过 Cargo 安装. 在项目目录执行:

```bash
npm install
npm run build
npm start
```

`npm start` 启动构建后的开发应用, 播放无需浏览器或常驻 HTTP 服务. 可选的账号登录需要系统 Google Chrome. 开发运行仍使用显式工具配置或 PATH; Windows 打包应用另带固定版本 ffmpeg / ffprobe / yt-dlp 和脚本 PO token provider.

开发时运行 `npm run dev`, 启动 Vite 构建监听与 Electron, 前端变动后重新构建并重载窗口. 修改主进程或 preload 后重启该命令. 开发与正式应用都通过 `app://app/` 读取资源, 不启动 Vite HTTP 服务, 不监听应用网络端口.

## 配置取流工具

远程片源需要 ffmpeg 和 ffprobe, YouTube 另外需要 yt-dlp. 工具查找优先级为 userData 下的 `tools.json`, 对应环境变量, 受控 yt-dlp 更新, 内置工具, 最后是开发环境 PATH. 只有真正的打包应用启用 `process.resourcesPath/tools/` 内置目录; 打包工具损坏时报告错误, 不静默使用任意 PATH 工具. 显式设置必须是工具可执行文件的绝对路径; Windows 仅接受原生 `.exe`, 不通过批处理或 shell 启动.

`tools.json` 示例:

```json
{
  "ffmpegPath": "C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe",
  "ffprobePath": "C:\\Tools\\ffmpeg\\bin\\ffprobe.exe",
  "ytdlpPath": "C:\\Tools\\yt-dlp.exe"
}
```

不使用该文件时, 可以设置 `STREAM_SYNC_FFMPEG`, `STREAM_SYNC_FFPROBE`, `STREAM_SYNC_YTDLP`. `tools.json` 在主进程启动时读取, 修改配置或启动环境后需重启应用. 缺少工具或路径无效会返回结构化错误, 不自动下载或安装. yt-dlp 使用 Electron 自带 Node 解 JS challenge, `ELECTRON_RUN_AS_NODE=1` 仅设置在该取流子进程的环境中.

在片源设置的 `取流工具` 区域查看实际选中的版本和来源, 点击 `检查并更新 yt-dlp` 才访问官方 GitHub 稳定版. 新版本经过有界下载、SHA256 和 `--version` 校验, 写入独立目录后原子切换记录. 当前播放继续, 下次取流按上述优先级选择. 界面可恢复上一受控版本或内置版本. 显式外部配置保持优先, 下载不会改写用户提供的工具. 启动和定时任务都不检查更新. provider 首版只随应用整包更新, 使用 Electron Node 和 userData 私有 `provider-cache/`, 不启动 HTTP provider 服务.

## Windows 本地打包

```bash
npm ci
npm run package:win
npm run package:check
node scripts/verify-packaged.mjs
```

electron-builder 固定为26.15.3, 保持 Electron44.9.0 和既有 React 版本. 构建输出在忽略的 `.release/`, 工具下载缓存与最小应用暂存位于 `.packaging/`. 首次显式执行 `tools:prepare` 或 `package:win` 时下载 [固定清单](packaging/tools-lock.json)中的工具和源码, 校验版本、大小与 SHA256, 使用单独固定的 provider 依赖补丁 lock 和 canvas N-API 包准备依赖. provider 仍为2.0.2原实现, 仅将 follow-redirects 固定到1.16.1, ip-address 固定到10.7.4; [补丁清单](packaging/provider-dependency-patches.json)及有效依赖索引随包保留. 保留已验证缓存; BtbN 日构建仅保留14天, 缺失时脚本应失败, 不自动改用 latest. 本地验证使用默认 Electron 图标, 未复用 Android 图标, 没有签名或外部发布.

应用包只从生成的最小文件白名单和受控资源目录构建. exe、DLL 和 provider 原生依赖位于 ASAR 外. 不包含本工程测试媒体和测试代码、cookie、Profile 或开发工作区; 第三方完整源码归档另作许可材料保留. 开发用测试源入口在发行包中隐藏, 用户仍可通过本地文件入口加载自己的媒体. NSIS 强制当前用户安装, 不建桌面/开始菜单快捷方式, 不自动启动, 卸载保留应用数据; ZIP 解压后运行 `Stream Syncer.exe`.

NSIS 对最终安装目录实施按实际资源最长相对路径计算的长度上限, 当前为100个UTF-16字符, 避免 Windows 传统路径限制导致卸载残留. 静默或交互初始化收到超长 `/D` 时返回2, 目录页也禁止继续超长路径. `package:win` 的局部构建适配只删除固定NSIS模板中早于检查的初始目录创建, 在内存中核验26.15.3及模板SHA256后执行, 不改写依赖文件或默认卸载器生成流程. 不直接调用 electron-builder CLI 绕过该入口. 已有安装会使 `powershell -NoProfile -File scripts/verify-installer.ps1` 跳过, 避免覆盖日常安装.

原应用的 MIT 声明不代表整包 MIT. 实际 FFmpeg 包为 LGPLv3 shared, yt-dlp 官方 Windows exe 为 GPLv3+, provider2.0.2 为 GPL-3.0-only, canvas3.2.3及其原生依赖另有许可. 原始许可、对应主项目源码、FFmpeg 构建信息和依赖索引随包保留. canvas 各原生 DLL 的精确来源/版本与完整对应源码仍有分发材料缺口, 这些产物限定为本地验证包, 不声明已可公开分发. 详见 [第三方说明](packaging/THIRD-PARTY-NOTICES.md).

2026-10-23本地验证: 类型检查和构建通过, Vitest 71文件/2090项通过, 默认离线Electron E2E 38项通过/6项条件跳过. `package:win` 与 `package:check` 通过, ASAR白名单18条, 工具与许可资源5011文件含inventory, 全部清单哈希匹配. unpacked和全新ZIP解压副本清除工具覆盖及开发PATH后, 均选中内置工具, 通过本地720p播放、实际ffmpeg copy/ffprobe、Electron Node provider/canvas和私有缓存ACL检查, 无外部请求或页面错误. NSIS专用短目录安装/卸载均exit0, 目标目录及应用注册表项完全移除; 静默及交互初始化拒绝超长目录exit2, 交互目录页也实测禁用安装按钮. 生产npm审计中应用与补丁后provider均为0个已知漏洞. 官方yt-dlp真实手动下载、SHA256/版本及重启选择smoke通过, 未使用真实cookie. 证据位于本地忽略目录 `.runtime-cache/p7-20261023/`.

旧长目录安装实验曾以exit0结束但各残留89个深路径文件, 完整卸载结论已撤回. 修复后增加路径限制并重新验证, 旧残留清理被自动审批以 `blocked by policy` 在进程启动前拒绝, 已保留清单, 未绕过删除. exe仍为未签名0.1.0本地评估包, 没有公开发布或真实平台长播通过的新增声明.

## 使用

1. 在片源设置中分别填官方源和解说源. 官方推荐 YouTube 直播, 保留 Twitch; 解说支持斗鱼和 B 站. 网络 m3u8 / mp4 / flv 地址统一经 ffmpeg 写入本地 HLS 缓冲, 本地文件和内置测试源保留直接播放.
2. 使用侧栏的 ◀◀ ◀ ▶ ▶▶ 按钮 (或 [ ] 快捷键) 手动调整偏移, 点中间数值可直接输入. 两路已在播放相同赛事 UI 时, 选择识别预设后点立即同步; 仅识别会报告偏移而不移动播放头.
3. 填解说方的斗鱼房间号连接弹幕. 弹幕按解说视频的媒体时间排队, 跟随同步后的播放位置.
4. 在配置编辑器中载入本地样片, 框选 ROI, 取帧, 逐个标注时钟字符, 再发布到本机. 具体流程见 [Profile Editor](docs/profile-editor.md).

有可选档位时, 片源设置及底部覆盖条分别显示官方和解说画质. 切画质只重启对应一路的 ffmpeg, 清零该路已应用的回退量. 两路画面就绪且已选择识别预设后, 自动尝试同步一次; 未就绪, 未选预设或同步未成功时会提示点击立即同步. YouTube 默认选择直播的 H.264/AAC HLS; 配置脚本 PO Token provider 后, 可列出高于最高 HLS 的 VP9/AV1 自适应档位, 如1440p60, VP9优先. `preferAdaptive` 默认 false, 自适应失败会自动回退 HLS. 具体配置和边界见 [平台说明](docs/platform-notes.md#youtube-自适应与-po-token). 不支持点播或回放. 斗鱼使用 PC `getH5PlayV1`, 原画可能需要登录, 列表标签不等于已经实测的分辨率.

配置编辑器位于应用内部的 `app://app/admin`, 本机窗口可直接进入, 无需管理令牌. 发布保留字段校验和 ETag 并发保护, 其他会话修改过同一预设时会要求重新载入.

## 可选账号登录

在片源设置的账号区域点击登录 YouTube 或登录斗鱼, 在新开的系统 Chrome 窗口内手动完成登录, 然后关闭该窗口. 应用使用各平台独立的 Chrome Profile, 禁用浏览器同步, 关窗后通过 `--remote-debugging-pipe` 读取 cookie, 不开放调试端口, 不读取日常 Chrome Profile. 登录完成后重新加载片源.

cookie 保存在 userData 的私有目录, 仅当前用户可读写. YouTube 调用 yt-dlp 时使用单独的临时副本, 在 `finally` 中删除. 退出登录会删除该平台 cookie 文件和专用 Chrome Profile. 界面只收到 cookie 数量, 认证键名称和过期时间等摘要, 不收到 cookie 值. 已登录状态表示存在尚未过期的已知认证键, 不保证平台仍接受该会话; 被拒绝时请重新登录.

## 数据目录

已发布预设默认保存在 Electron `app.getPath('userData')/presets`, 每个预设一份 JSON. 编辑器草稿保存在当前应用 Profile 的 IndexedDB, 播放设置保存在本机存储.

应用在同一 userData 下使用 `browser-profile/<platform>/`, `cookies/<platform>.txt`, `tools.json` 和 `buffer/<session>/<role>/`. 两路各有一个 ffmpeg 子进程, 默认按播放列表 `EXTINF` 累计保留最近约 180 s, 以完整分片为边界, 不把 90 个分片直接视为 180 s. 缓冲量和启动, 停滞, 重连, 失败状态通过 IPC 事件显示. 每次重新加载或切画质生成新的缓冲 URL; 自动重连保留 URL, 追加 discontinuity 并重新解析签名地址. HLS默认最多连续重试 5 次, 间隔 1 / 2 / 5 / 10 / 15 s, 连续稳定产出 30 s 后重置失败计数. 自适应媒体经双管道转为fMP4, 连续失败两轮后切换最佳HLS并保持当前能力URL. 正常退出会终止 ffmpeg 进程树并删除本次会话目录, 不是永久录像.

以下环境变量供本机开发和隔离验证使用:

| 变量 | 默认行为 | 用途 |
| --- | --- | --- |
| `STREAM_SYNC_USER_DATA_DIR` | Electron 默认 userData | 隔离 Chromium Profile, 设置和草稿 |
| `STREAM_SYNC_DATA_DIR` | userData | 覆盖预设数据根目录, 文件仍位于其 `presets/` 子目录 |

旧版 HTTP 主机, API 端口和管理令牌配置不再用于启动桌面应用. E2E 每个场景独立使用 `e2e/.data/` 中的临时 userData 和预设目录, 关闭应用后清理, 不接触日常数据.

## 安全与媒体

Electron 窗口启用 `contextIsolation`, `sandbox`, `webSecurity`, 关闭 `nodeIntegration`. 页面不能直接使用 Node, 只能通过 preload 暴露的 `window.streamSyncer` 白名单接口调用主进程. 主进程校验调用来源和参数; 外部导航, 新窗口和权限请求被拒绝. 编辑器的写入资格来自受信任的本机应用窗口, 不是共享令牌.

页面, 本地测试媒体和本地缓冲使用同源自定义协议. 缓冲路径只允许读取活动会话, 角色和 generation 对应的播放列表与分片, 不接受任意文件路径. 平台 API 使用 safeFetch 的 SSRF 防护, 解析出的 ffmpeg URL 输入先通过 checkUrl 校验; 此类输入的后续重定向和DNS由ffmpeg处理. 自适应分片由主进程 safeFetch 逐跳检查 googlevideo HTTPS 域名和DNS后读取, 签名URL不传给ffmpeg或渲染进程. 保留的媒体登记路径使用不透明标识, 由主进程 safeFetch 读取, 支持 Range 和受控 HLS 子资源. 具体边界见 [媒体路径与安全](docs/media-proxy.md).

安全配置和单元测试不代表真实平台已可播放. 平台认证, CDN 限制, 远程媒体兼容性, 登录和实际直播稳定性仍需单独验证.

## 开发与验证

```bash
npm run dev          # Vite build watch + Electron
npm run typecheck    # 应用, 主进程和 E2E 类型检查
npm test             # Vitest 单元测试
npm run fixtures     # ffmpeg 生成测试片源
npm run build        # 构建 renderer, main 和 preload
npm run test:e2e     # 启动真实 Electron 的 Playwright 场景
```

生成测试源需要 ffmpeg 在 PATH 中. 生成的视频位于 `public/test-sources/`, 不进入版本控制. 两段合成视频内置精确的 5 s 延迟, 自动同步场景验证识别误差 <=0.25 s 和同步残差 <=0.35 s.

E2E 通过 `_electron.launch` 启动 `dist/electron/main.cjs`, 无 webServer 和外部浏览器. 原有场景继续覆盖 IPC, 本机编辑器和媒体路径安全. 新增场景通过真正的 BufferManager 和 ffmpeg 将本地 HLS 测试源实时写入缓冲, 检查播放与回退; 不依赖真实平台. 弹幕测试只在主进程边缘注入确定消息, preload, 订阅, 时间线和叠加层均使用实际实现. 真实网络平台测试通过 `STREAM_SYNC_LIVE_TESTS=1` 显式启用, 默认不运行.

2026-10-23另一次1440p60实时软件模式验收使用新直播 `1cQoYBb0Xow`, 基线仍为 P7 前的 `a9b2fac`. 30秒短测通过, 一次1800秒长测在墙钟1697.067900秒、实际媒体1696.028394秒时因取流请求失败、缓冲耗尽和重连状态断言失败. 101761帧、丢0帧与约59.999585fps说明失败前的软件解码观察, 不能将这轮记为30分钟连续通过. 没有重跑长测或等待重连成功. 该基线复用既有provider缓存, 不声称缓存完全隔离; P7的私有XDG缓存改动另行验证. 旧硬解失败、30fps通过和本地双路60fps通过记录均保留, 详见平台说明.

2026-10-23 本地构建、2019项Vitest、94项Rust已通过. 离线Electron E2E覆盖IPC、播放、循环缓冲与VP9到H.264的fMP4切换, 早期沙箱无法启动Chromium的记录属于历史限制. 当前结果以本地运行记录为准, 启动失败或跳过的场景不记为通过.

随后可选软件解码增量的本地构建/类型检查、2054项Vitest和默认离线Electron E2E 37 passed/6 opt-in skipped通过. 同一真实1440p60 VP9捕获片段的单路/双路各约30秒短测均丢0帧. 新增至少57fps帧增量断言后, 双路30秒复验及一次双路1800秒本地长测通过: 每路实际播放超过1800秒, 分别108018/108015帧, 均丢0帧, 送显均约60fps. CDP确认每路软件解码, CPU与内存样本见[平台说明](docs/platform-notes.md#可选软件解码兼容模式). 此为同片段本地循环的双路负载验收, 不代表双平台实时取流, 不覆盖原P5b硬解严格长播失败记录.

真实1440p场景为 `npx playwright test e2e/youtube-adaptive.spec.ts`, 需同时设置 `STREAM_SYNC_LIVE_TESTS=1`, `STREAM_SYNC_YOUTUBE_ADAPTIVE=1`, 两个provider目录、`STREAM_SYNC_YOUTUBE_LIVE_URL`和显式授权的`STREAM_SYNC_YOUTUBE_ADAPTIVE_COOKIE_FILE`. 只将cookie导入可丢弃profile, 不读取日常浏览器资料. 默认在至少30秒fMP4缓冲后观察30秒实际1440p播放; `STREAM_SYNC_ADAPTIVE_SECONDS=1800`和`STREAM_SYNC_ADAPTIVE_LONG=1`显式启用30分钟持续验收. `STREAM_SYNC_ADAPTIVE_EXPECT_FPS=60`还要求1440p60菜单项和实际增量帧率, 不只检查标签. 测试记录实际高度、CDP解码器属性、帧增量、分片可读性、缓冲间隙、播放速率、页面可见性和重连/回退, HLS回退不会算作1440p通过. 脱敏JSON写入Playwright输出目录.

在上述真实场景中额外设置 `STREAM_SYNC_ADAPTIVE_PERSISTED_SOFTWARE=1`, 即通过生产界面保存软件模式, 关闭并复用同一个可丢弃profile重启, 再运行相同的实时取流与播放验收. 此路径明确不使用测试软件快捷参数, 检查 `forcedByCommandLine=false`, VpxVideoDecoder/platform=false和GPU合成未关闭, 并记录实际送显帧率、掉帧比例及Electron进程CPU/内存样本. 30fps源应设置 `STREAM_SYNC_ADAPTIVE_EXPECT_FPS=30`, 不能当作60fps验收.

系统Chrome手工登录与退出、真实平台画质切换、30分钟直播和上游EOF恢复等项目应按各自实测结果验收, 不从离线回归推断通过. 当前真实状态见 [平台说明](docs/platform-notes.md#验证边界).

真实1440p30和1440p60短测通过; 此前自动硬解严格长时播放失败: 已观察到取流连续、本地仍有缓冲但播放停顿与丢帧. 同片段本地D3D11回放可间歇复现, 硬解短时复验也可通过, 不能据此认定硬件或驱动根因. 历史失败记录继续保留于[平台说明](docs/platform-notes.md#验证边界).

2026-10-23通过正式UI持久化软件模式并重启后, 单路YouTube实时2560x1440 VP9 30fps的30秒短测及一次30分钟长测通过: 实际媒体1800.015706秒、54000帧、丢0帧、送显29.999738fps, 本地366个分片可读, 音视频sq连续, 无重连或回退. CDP为VpxVideoDecoder/platform=false, 源码与生产构建哈希在长测前后保持一致. 当次原60fps链接已结束直播, 因此该结果只覆盖30fps实时软件模式, 不替代60fps实时30分钟、AV1、其他设备或硬解根因验收.

片源设置的 `视频解码` 区域提供可选的 `软件解码兼容模式`, 默认关闭, 继续由 Chromium 自动选择并优先使用可用硬件解码. 开关保存到本机 userData 下的 `decoder-preferences.json`, 手动关闭应用并重新打开后生效, 保存时当前播放会继续. 界面分别显示当前生效模式与已保存的待重启选择. 软件解码可能增加 CPU 占用, 不保证消除所有停顿. 此选项只禁用硬件视频解码, 保留 GPU 合成和现有 VP9/HLS/同步策略. 若通过启动参数强制软件解码, 还需移除该参数才能恢复自动模式.

此选择同时作用于应用内的官方画面和解说两路视频, 不需要分别配置.

`e2e/decoder-settings.spec.ts` 默认离线验证真实 UI 保存, 同一可丢弃 profile 重启和恢复默认, 不读取日常 profile. `e2e/software-decode.spec.ts` 需显式设置 `STREAM_SYNC_SOFTWARE_DECODE_TESTS=1` 与 `STREAM_SYNC_SOFTWARE_DECODE_CAPTURE=<已授权的本地捕获目录>` 才运行, 从生产设置启动单路及双路真实 VP9 片段并检查 CDP 解码器. `STREAM_SYNC_SOFTWARE_DECODE_SECONDS` 默认30, 超过120秒还需 `STREAM_SYNC_SOFTWARE_DECODE_LONG=1`, 设为1800准备30分钟验收. 诊断记录每路播放与 Electron 进程 CPU/内存样本, 默认不访问网络. 旧 `STREAM_SYNC_E2E_SOFTWARE_VIDEO=1` 仍只用于 `adaptive-local.spec.ts` 的测试子进程对照, 新生产设置验收不使用它.

## 目录

```text
electron/          主进程, 缓冲, 工具定位, 登录, preload 与 IPC
src/app/           会话, 设置与统一 ApiClient IPC 接口
src/core/          纯逻辑: 识别, 跳秒, 偏移估计与同步计划
src/media/         两路 video 元素与 hls.js
src/recognition/   取帧, 采样与识别 Worker
src/sync/          自动同步控制器
src/ui/            播放页与配置编辑器
server/            主进程复用的平台解析, SSRF 防护, 预设存储与弹幕中继
e2e/               真实 Electron 场景与测试数据隔离
```

进一步说明见 [docs/index.md](docs/index.md). P0 原型及其历史证据保留在 `prototype/`, 正式应用不在该目录开发.
