# Stream Syncer

把官方赛事纯净流和国内解说流对到同一个时间点: **官方画面 + 解说声音 + 弹幕叠加**.

同一场比赛, 官方源画质好但没有解说, 国内直播有解说但通常慢十几秒. 应用同时播放两路视频, 识别画面中的倒计时跳秒, 估算并应用延迟差.

当前为 P1 Electron 桌面版, 沿用 React 播放器和识别核心. Windows 为主要平台, macOS / Linux 尚待实际验证. P2 的 ffmpeg 循环缓冲, yt-dlp, 登录态和新取流流程尚未接入. 完整阶段计划见 [docs/plan.md](docs/plan.md).

## 快速开始

需要 Node.js >=22.12 和 npm. 在项目目录执行:

```bash
npm install
npm run build
npm start
```

`npm start` 启动构建后的 Electron 应用, 无需浏览器或常驻 HTTP 服务. 当前不生成安装包, 安装包属于 P7.

开发时运行 `npm run dev`, 启动 Vite 构建监听与 Electron, 前端变动后重新构建并重载窗口. 修改主进程或 preload 后重启该命令. 开发与正式应用都通过 `app://app/` 读取资源, 不启动 Vite HTTP 服务, 不监听应用网络端口.

## 使用

1. 在片源设置中分别填官方源和解说源, 支持直接媒体地址, 测试源以及当前已有的平台解析.
2. 使用侧栏按钮或滑条手动调整偏移. 两路已在播放相同赛事 UI 时, 选择识别预设后点立即同步; 仅识别会报告偏移而不移动播放头.
3. 填解说方的斗鱼房间号连接弹幕. 弹幕按解说视频的媒体时间排队, 跟随同步后的播放位置.
4. 在配置编辑器中载入本地样片, 框选 ROI, 取帧, 逐个标注时钟字符, 再发布到本机. 具体流程见 [Profile Editor](docs/profile-editor.md).

配置编辑器位于应用内部的 `app://app/admin`, 本机窗口可直接进入, 无需管理令牌. 发布保留字段校验和 ETag 并发保护, 其他会话修改过同一预设时会要求重新载入.

## 数据目录

已发布预设默认保存在 Electron `app.getPath('userData')/presets`, 每个预设一份 JSON. 编辑器草稿保存在当前应用 Profile 的 IndexedDB, 播放设置保存在本机存储.

以下环境变量供本机开发和隔离验证使用:

| 变量 | 默认行为 | 用途 |
| --- | --- | --- |
| `STREAM_SYNC_USER_DATA_DIR` | Electron 默认 userData | 隔离 Chromium Profile, 设置和草稿 |
| `STREAM_SYNC_DATA_DIR` | userData | 覆盖预设数据根目录, 文件仍位于其 `presets/` 子目录 |

旧版 HTTP 主机, API 端口和管理令牌配置不再用于启动桌面应用. E2E 每个场景独立使用 `e2e/.data/` 中的临时 userData 和预设目录, 关闭应用后清理, 不接触日常数据.

## 安全与媒体

Electron 窗口启用 `contextIsolation`, `sandbox`, `webSecurity`, 关闭 `nodeIntegration`. 页面不能直接使用 Node, 只能通过 preload 暴露的 `window.streamSyncer` 白名单接口调用主进程. 主进程校验调用来源和参数; 外部导航, 新窗口和权限请求被拒绝. 编辑器的写入资格来自受信任的本机应用窗口, 不是共享令牌.

页面, 本地测试媒体和主进程登记的远程媒体使用同源自定义协议. 媒体地址使用不透明标识, 渲染进程不能通过协议传入任意目标 URL. 主进程远程读取继续使用 SSRF 防护, 校验协议, 端口, 域名, DNS 地址和每次重定向. 媒体路径支持 Range, HLS 播放列表的子资源同样受控. 具体边界见 [媒体路径与安全](docs/media-proxy.md).

安全配置不代表真实平台已可播放. 平台认证, CDN 限制, 远程媒体兼容性和实际直播稳定性仍需单独验证; P1 不包含新的登录或画质取流能力.

## 开发与验证

```bash
npm run dev          # Vite build watch + Electron
npm run typecheck    # 应用, 主进程和 E2E 类型检查
npm test             # Vitest 单元测试
npm run fixtures     # ffmpeg 生成测试片源
npm run build        # 构建 renderer, main 和 preload
npm run test:e2e     # 启动真实 Electron 的 Playwright 场景
```

生成测试源需要 ffmpeg 在 PATH 中. 本机可使用 `<home>\Desktop\ffmpeg\bin`. 生成的视频位于 `public/test-sources/`, 不进入版本控制. 两段合成视频内置精确的 5 s 延迟, 自动同步场景验证识别误差 <=0.25 s 和同步残差 <=0.35 s.

E2E 通过 `_electron.launch` 启动 `dist/electron/main.cjs`, 无 webServer 和外部浏览器. 原有 31 个场景保留, HTTP API 与令牌门禁场景改为 IPC, 本机编辑器和媒体路径安全检查. 弹幕测试只在主进程边缘注入确定消息, preload, 订阅, 时间线和叠加层均使用实际实现.

**Codex 当前执行沙箱无法创建 Chromium restricted token.** 在沙箱内只运行类型检查, 单元测试, 构建和 `npx playwright test --list`. 完整 E2E 必须由指挥方在普通用户终端, 先构建后运行 `npx playwright test`. 启动失败会给出明确提示, 不记为验证通过.

## 目录

```text
electron/          主进程, preload, IPC 白名单与自定义协议
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
