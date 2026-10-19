# Stream Syncer

把官方赛事纯净流和国内解说流对到同一个时间点: **官方画面 + 解说声音 + 弹幕叠加**.

同一场比赛, 官方源画质好但没有解说, 国内直播有解说但通常慢十几秒. 应用同时播放两路视频, 识别画面中的倒计时跳秒, 估算并应用延迟差.

当前为 P2 Electron 桌面版, 已接入 ffmpeg 本地循环缓冲, YouTube / 斗鱼取流, 独立 Chrome 登录和画质切换, 沿用 React 播放器和识别核心. Windows 为主要平台, macOS / Linux 尚待实际验证. 正式应用的真实平台与登录验收仍需在沙箱外完成, P0 原型证据不能替代本轮验收. 完整阶段计划见 [docs/plan.md](docs/plan.md).

## 快速开始

需要 Node.js >=22.12 和 npm. 在项目目录执行:

```bash
npm install
npm run build
npm start
```

`npm start` 启动构建后的 Electron 应用, 播放无需浏览器或常驻 HTTP 服务. 可选的账号登录需要系统 Google Chrome. 当前不生成安装包, 也不捆绑 ffmpeg / ffprobe / yt-dlp, 二进制打包属于 P7.

开发时运行 `npm run dev`, 启动 Vite 构建监听与 Electron, 前端变动后重新构建并重载窗口. 修改主进程或 preload 后重启该命令. 开发与正式应用都通过 `app://app/` 读取资源, 不启动 Vite HTTP 服务, 不监听应用网络端口.

## 配置取流工具

远程片源需要 ffmpeg 和 ffprobe, YouTube 另外需要 yt-dlp. 工具查找优先级为 userData 下的 `tools.json`, 对应环境变量, 最后是 PATH. 显式设置必须是工具可执行文件的绝对路径; Windows 仅接受原生 `.exe`, 不通过批处理或 shell 启动.

`tools.json` 示例:

```json
{
  "ffmpegPath": "C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe",
  "ffprobePath": "C:\\Tools\\ffmpeg\\bin\\ffprobe.exe",
  "ytdlpPath": "C:\\Tools\\yt-dlp.exe"
}
```

不使用该文件时, 可以设置 `STREAM_SYNC_FFMPEG`, `STREAM_SYNC_FFPROBE`, `STREAM_SYNC_YTDLP`. `tools.json` 在主进程启动时读取, 修改配置或启动环境后需重启应用. 缺少工具或路径无效会返回结构化错误, 不自动下载或安装. yt-dlp 使用 Electron 自带 Node 解 JS challenge, `ELECTRON_RUN_AS_NODE=1` 仅设置在该取流子进程的环境中.

## 使用

1. 在片源设置中分别填官方源和解说源. 官方推荐 YouTube 直播, 保留 Twitch; 解说支持斗鱼和 B 站. 网络 m3u8 / mp4 / flv 地址统一经 ffmpeg 写入本地 HLS 缓冲, 本地文件和内置测试源保留直接播放.
2. 使用侧栏的 ◀◀ ◀ ▶ ▶▶ 按钮 (或 [ ] 快捷键) 手动调整偏移, 点中间数值可直接输入. 两路已在播放相同赛事 UI 时, 选择识别预设后点立即同步; 仅识别会报告偏移而不移动播放头.
3. 填解说方的斗鱼房间号连接弹幕. 弹幕按解说视频的媒体时间排队, 跟随同步后的播放位置.
4. 在配置编辑器中载入本地样片, 框选 ROI, 取帧, 逐个标注时钟字符, 再发布到本机. 具体流程见 [Profile Editor](docs/profile-editor.md).

有可选档位时, 片源设置及底部覆盖条分别显示官方和解说画质. 切画质只重启对应一路的 ffmpeg, 清零该路已应用的回退量. 两路画面就绪且已选择识别预设后, 自动尝试同步一次; 未就绪, 未选预设或同步未成功时会提示点击立即同步. YouTube 当前只支持直播的 H.264/AAC 双轨合一 HLS, 不支持点播, 回放或单独的 DASH 音视频轨. 斗鱼使用 PC `getH5PlayV1`, 原画可能需要登录, 列表标签不等于已经实测的分辨率.

配置编辑器位于应用内部的 `app://app/admin`, 本机窗口可直接进入, 无需管理令牌. 发布保留字段校验和 ETag 并发保护, 其他会话修改过同一预设时会要求重新载入.

## 可选账号登录

在片源设置的账号区域点击登录 YouTube 或登录斗鱼, 在新开的系统 Chrome 窗口内手动完成登录, 然后关闭该窗口. 应用使用各平台独立的 Chrome Profile, 禁用浏览器同步, 关窗后通过 `--remote-debugging-pipe` 读取 cookie, 不开放调试端口, 不读取日常 Chrome Profile. 登录完成后重新加载片源.

cookie 保存在 userData 的私有目录, 仅当前用户可读写. YouTube 调用 yt-dlp 时使用单独的临时副本, 在 `finally` 中删除. 退出登录会删除该平台 cookie 文件和专用 Chrome Profile. 界面只收到 cookie 数量, 认证键名称和过期时间等摘要, 不收到 cookie 值. 已登录状态表示存在尚未过期的已知认证键, 不保证平台仍接受该会话; 被拒绝时请重新登录.

## 数据目录

已发布预设默认保存在 Electron `app.getPath('userData')/presets`, 每个预设一份 JSON. 编辑器草稿保存在当前应用 Profile 的 IndexedDB, 播放设置保存在本机存储.

P2 在同一 userData 下使用 `browser-profile/<platform>/`, `cookies/<platform>.txt`, `tools.json` 和 `buffer/<session>/<role>/`. 两路各有一个 ffmpeg 子进程, 默认按播放列表 `EXTINF` 累计保留最近约 180 s, 以完整分片为边界, 不把 90 个分片直接视为 180 s. 缓冲量和启动, 停滞, 重连, 失败状态通过 IPC 事件显示. 每次重新加载或切画质生成新的缓冲 URL; 自动重连保留 URL, 追加 discontinuity 并重新解析签名地址. 默认最多连续重试 5 次, 间隔 1 / 2 / 5 / 10 / 15 s, 连续稳定产出 30 s 后重置失败计数. 正常退出会终止 ffmpeg 进程树并删除本次会话目录, 不是永久录像.

以下环境变量供本机开发和隔离验证使用:

| 变量 | 默认行为 | 用途 |
| --- | --- | --- |
| `STREAM_SYNC_USER_DATA_DIR` | Electron 默认 userData | 隔离 Chromium Profile, 设置和草稿 |
| `STREAM_SYNC_DATA_DIR` | userData | 覆盖预设数据根目录, 文件仍位于其 `presets/` 子目录 |

旧版 HTTP 主机, API 端口和管理令牌配置不再用于启动桌面应用. E2E 每个场景独立使用 `e2e/.data/` 中的临时 userData 和预设目录, 关闭应用后清理, 不接触日常数据.

## 安全与媒体

Electron 窗口启用 `contextIsolation`, `sandbox`, `webSecurity`, 关闭 `nodeIntegration`. 页面不能直接使用 Node, 只能通过 preload 暴露的 `window.streamSyncer` 白名单接口调用主进程. 主进程校验调用来源和参数; 外部导航, 新窗口和权限请求被拒绝. 编辑器的写入资格来自受信任的本机应用窗口, 不是共享令牌.

页面, 本地测试媒体和本地缓冲使用同源自定义协议. 缓冲路径只允许读取活动会话, 角色和 generation 对应的播放列表与分片, 不接受任意文件路径. 平台 API 使用 safeFetch 的 SSRF 防护, 解析出的 ffmpeg 输入先通过 checkUrl 校验. 后续媒体网络访问由 ffmpeg 执行, 其重定向和 DNS 不经过 safeFetch 的逐跳检查. 保留的媒体登记路径使用不透明标识, 由主进程 safeFetch 读取, 支持 Range 和受控 HLS 子资源. 具体边界见 [媒体路径与安全](docs/media-proxy.md).

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

**Codex 当前执行沙箱无法创建 Chromium restricted token.** 在沙箱内只运行类型检查, 单元测试, 构建和 `npx playwright test --list`. 完整 E2E 必须由指挥方在普通用户终端, 先构建后运行 `npx playwright test`. 启动失败会给出明确提示, 不记为验证通过.

沙箱外还需分别验证系统 Chrome 登录与退出, 真实 YouTube / 斗鱼取流和画质切换, 连续播放超过 300 s 及上游 EOF 后重新解析恢复, 以及回退后不会被拉回直播边缘. 自动化测试结果与这些真实平台验收应分开记录.

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
