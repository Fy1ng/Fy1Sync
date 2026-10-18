# P0b 手动登录与 Cookie 复测

本工具沿用已安装的 Electron, 不新增依赖, 不自动填写账号或执行登录. YouTube 使用 `persist:youtube`, 斗鱼使用 `persist:douyu`, 两个平台的浏览器会话相互隔离. 一次只运行一个登录进程.

所有命令在 `Stream Syncer Claude/prototype/` 中执行. 依赖和 Electron 二进制复用现有原型. 本轮只完成实现和静态语法检查, 没有启动登录窗口或执行 Cookie 依赖的复测. `prototype/REPORT.md` 末尾已记录编排器在沙箱外运行 electron-playback 的 PASS, 不需要在当前沙箱再次启动窗口.

## 1. 用户手动登录

在正常的用户 PowerShell 中进入原型目录:

```powershell
Set-Location '<home>\Documents\ChatGPT\DouyuPlus1\Stream Syncer Claude\prototype'
npm run login -- youtube
```

在打开的 YouTube 窗口中手动完成登录. 确认页面显示登录后的账号状态, 然后关闭该进程打开的所有登录窗口, 包括登录弹窗. 命令返回后才继续下一步:

```powershell
npm run login -- douyu
```

在斗鱼窗口中手动完成登录, 然后关闭所有登录窗口并等待命令返回.

窗口关闭后, 工具先刷新该平台会话的 Cookie 存储, 再原子导出 Netscape Cookie 文件. 文件路径固定为:

- YouTube: `.runtime/cookies/youtube.txt`.
- 斗鱼: `.runtime/cookies/douyu.txt`.

YouTube 导出仅包含 `youtube.com` 及其子域, Google 登录使用的 `google.com` 根域 Cookie 和 `accounts.google.com` 及其子域. 不导出其他 Google 服务域的独立 Cookie. 斗鱼仅包含 `douyu.com` 及其子域. HttpOnly Cookie 使用 Netscape 的 `#HttpOnly_` 前缀.

成功时终端仅报告 `cookieCount` 和白名单内出现的认证 Cookie 键名, 从不报告 Cookie 值. 键名存在或数量大于零不代表服务端已接受登录. Google 也可能限制嵌入式浏览器登录, 需要用户实际验证.

浏览器资料保留在 `.runtime/login-profile/`, 包括 sessionData, cache, logs, crash dumps 和临时文件. 这些目录及 Cookie 文件都在已忽略的 `.runtime/` 下. Windows 写入前执行 `icacls /inheritance:r /grant:r` 授予当前用户 SID 的 FullControl, 并读取 ACL 验证没有其他主体的权限. 验证失败即停止, 不降级为公开权限. POSIX 下目录使用 `0700`, 导出文件使用 `0600`. 请勿分享 Cookie 文件或浏览器资料.

## 2. 复测 P0 item 3, yt-dlp 使用 Electron Node

以下使用原型内已经下载并校验的官方 yt-dlp executable. `run.cjs` 自行将 Electron 作为 bundled Node 运行时, 仅对子进程设置 `ELECTRON_RUN_AS_NODE=1`:

```powershell
$env:P0_COOKIES=(Resolve-Path '.runtime/cookies/youtube.txt').Path
$env:YTDLP=(Resolve-Path '.runtime/yt-dlp/yt-dlp.exe').Path
node ytdlp-js-runtime/run.cjs
```

## 3. 复测 P0 item 2, YouTube 直播缓冲

使用仍在直播的公开地址时, 可以先设置 `$env:YOUTUBE_LIVE_URL='https://www.youtube.com/watch?v=<actual-live-id>'`. 不设置时沿用原型的默认候选来源. 正式运行命令:

```powershell
$env:P0_COOKIES=(Resolve-Path '.runtime/cookies/youtube.txt').Path
$env:YTDLP_PATH=(Resolve-Path '.runtime/yt-dlp/yt-dlp.exe').Path
$env:YTDLP_NODE_RUNTIME=(Resolve-Path 'node_modules/electron/dist/electron.exe').Path
$env:BUFFER_SECONDS='310'
node ffmpeg-live-buffer/run.mjs
```

yt-dlp 会改写 Cookie 文件, 因此两个原型脚本都只把受限临时副本传给 `--cookies`, 调用结束后删除临时副本, 保留登录工具导出的原文件. 缓冲测试不能把 `BUFFER_SECONDS` 降到 300 以下. 只有实际取流, 缓冲和媒体检查成功后, 才算对应项目通过.

如果已成功生成 `.media/youtube-hls/index.m3u8`, 可在正常用户 PowerShell 中继续验证实际播放和回退, 当前沙箱不执行此命令:

```powershell
node electron-playback/run.cjs live youtube-hls/index.m3u8
```

## 4. 复测斗鱼登录后画质

```powershell
$env:NODE_USE_ENV_PROXY='1'
$env:P0_COOKIES=(Resolve-Path '.runtime/cookies/douyu.txt').Path
node douyu-quickjs/run.mjs
```

需要指定当前正在直播的公开数字房间时, 在运行前设置 `$env:P0_DOUYU_ROOM='9999'`, 将值替换为实际房间号. 脚本携带斗鱼 Cookie 请求页面和 ratestream, 逐项记录请求 rate, 返回 rate, ffprobe 实测分辨率及 fps. API 的原画或超清标签不能替代实测画质, 也不能据此保证登录后一定能取得更高分辨率. 不应打印 Cookie 值或签名媒体 URL.

复测后如需清除本轮设置的进程环境变量:

```powershell
Remove-Item Env:P0_COOKIES,Env:YTDLP,Env:YTDLP_PATH,Env:YTDLP_NODE_RUNTIME,Env:BUFFER_SECONDS,Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue
```

实际登录, Cookie 导出 ACL, YouTube 认证与取流, 310 s 缓冲, 斗鱼高画质以及 live 播放和回退均待用户在正常前台环境中运行验证. 语法检查不能替代这些运行验收.
