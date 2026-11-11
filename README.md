<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Fy1Sync: 画面与解说, 同一刻. 将赛事画面, 主播解说和弹幕对齐的跨平台桌面播放器.">
</p>

# Fy1Sync

**看官方赛事画面, 听喜欢的主播解说, 让弹幕跟上正在发生的这一刻.**

Fy1Sync 是一款支持 Windows, macOS 和 Linux 的桌面播放器. 将两路直播或录像放进同一个窗口, 分别选择画面和声音, 再通过延后较快的一路把它们对齐. 主要观赛场景是 CS2, 也可以手动组合其他内容的片源.

[下载安装](#下载安装) · [开始观看](#开始观看) · [接入范围](#接入范围) · [使用边界](#使用边界) · [从源码运行](#从源码运行)

<p align="center">
  <img src="./assets/readme/player.webp" width="100%" alt="Fy1Sync 当前观赛界面: 主画面, 解说小窗, 独立音量, 5 秒手动偏移和右侧弹幕列表. 使用本地合成片源与测试弹幕.">
</p>

*界面截图使用当前代码渲染, 片源与弹幕均为离线测试数据, 不代表真实赛事或自动对齐效果.*

## 为一次观赛准备好

| 想做什么 | Fy1Sync 提供的方式 |
| --- | --- |
| 看赛事原画, 听另一位主播解说 | 两路片源独立载入, 主画面与小窗可切换, 两路音量分别调节 |
| 解说先喊出来, 或画面已经打完 | 回退或快进画面进行微调, 也可直接输入延后哪一路及秒数 |
| 不想让弹幕提前剧透 | 斗鱼和虎牙弹幕按解说侧的延后排队显示, 可调样式与屏蔽规则 |
| 让 CS2 两路画面自动找同一时刻 | 默认自动查找并识别比赛倒计时, 支持单次或定时对齐, **目前仍在测试** |
| 留住主播反应, 同时看清比赛 | 从解说画面框选摄像头小窗, 调整位置与缩放, 可选画质增强 |
| 顺手看其他直播, 或把画面放到桌面角落 | 额外直播浮窗和增强画中画; 额外直播独立播放, 不加入双路对齐 |
| 查比赛或留下一段画面 | CS2 赛程入口, 截图和 GIF 导出; 截图与 GIF 需先在设置中启用 |

斗鱼的账号, 关注, 背包, 弹幕记录和房间数据集中放在设置里. 发送弹幕, 赠礼, 房间任务, 批量任务和粉丝牌等账号操作属于默认关闭的实验功能, 详见[使用边界](#使用边界).

## 下载安装

当前发布版本为 `v0.4.1`, 完善多平台内嵌登录, 抖音分享链接解析和斗鱼观时状态, 提供 Windows, macOS 和 Linux 安装包与便携包. 各平台使用 GitHub CI 原生构建并检查. [版本说明与 SHA256 校验文件](https://github.com/Fy1ng/Fy1Sync/releases/tag/v0.4.1).

macOS 已加入 Apple Silicon `arm64` 和 Intel `x64` 的本机开发与 DMG/ZIP 构建入口, 要求 macOS 13 Ventura 或更新版本, 见[从源码运行](#从源码运行). 当前 Releases 中的上述版本仍以 Windows 发布包为准; macOS 原生构建, 安装和签名验收需要在对应 Mac 上完成.

| 版本 | 使用方式 |
| --- | --- |
| [Windows x64 安装包](https://github.com/Fy1ng/Fy1Sync/releases/download/v0.4.1/Fy1Sync-0.4.1-win-x64-nsis.exe) | NSIS 安装向导, 支持覆盖升级 |
| [Windows x64 免安装版](https://github.com/Fy1ng/Fy1Sync/releases/download/v0.4.1/Fy1Sync-0.4.1-win-x64-portable.zip) | 解压整个目录后运行 `Fy1Sync.exe` |
| [macOS Intel x64](https://github.com/Fy1ng/Fy1Sync/releases/download/v0.4.1/Fy1Sync-0.4.1-mac-x64.dmg) / [Apple Silicon arm64](https://github.com/Fy1ng/Fy1Sync/releases/download/v0.4.1/Fy1Sync-0.4.1-mac-arm64.dmg) | DMG 安装包, macOS 13+; 发布页同时提供 ZIP |
| [Linux x64](https://github.com/Fy1ng/Fy1Sync/releases/download/v0.4.1/Fy1Sync-0.4.1-linux-x64.deb) / [Linux arm64](https://github.com/Fy1ng/Fy1Sync/releases/download/v0.4.1/Fy1Sync-0.4.1-linux-arm64.deb) | DEB 安装包; 发布页同时提供 AppImage 和 tar.gz |

[查看全部 Releases](https://github.com/Fy1ng/Fy1Sync/releases) / [GitCode 下载镜像](https://gitcode.com/Fy1ng/Fy1Sync/releases). 请区分应用版本与单独发布的 FFmpeg 构建资源.

发布包已带上取流和转码所需的工具资源, 普通使用无需安装 Node.js 或 Rust. 斗鱼, B 站, 虎牙和抖音通过统一的应用内悬浮卡片登录, 左侧扫码, 右侧短信或密码. 需要二次验证时在卡片内继续, 复杂验证显示官方页面. YouTube 登录需要安装 [Google Chrome](https://www.google.com/chrome/), 在应用打开的独立窗口中自行完成登录.

## 开始观看

1. **添加画面和解说.** 在起始页粘贴直播间链接, 按回车添加. YouTube / Twitch 默认放到画面侧, 斗鱼 / 哔哩哔哩 / 虎牙默认放到解说侧. 输入裸房间号时选择所属平台; 直链和本地文件按提示选择放置位置. 也可以从 CS2 赛程选择官方直播.
2. **决定看哪一路, 听哪一路.** 默认播放解说侧声音, 官方侧静音. 点击小画面可切换主画面, 两路音量可以单独调整.
3. **把发生的时刻对上.** 解说比画面晚, 就回退画面; 解说比画面早, 就快进画面, 或点中间的秒数让解说侧延后. 当前允许设置的相对偏移范围为 `-60` 到 `+60` 秒, 实际可调整量取决于已积累的缓冲或录像范围.
4. **再尝试自动对齐.** 两路都已载入, 且都在同一回合的正式倒计时阶段时, 点击自动对齐. 默认基础模式无需制作样式包, 会自动寻找时钟并验证连续递减. 基础模式未适配的字体可在对齐选项中切换样式包模式, 对不上时继续使用手动微调.

基础模式的寻找进度和实际二值化画面显示在右侧弹幕列表上方, 本地文件也可查看. 只需在官方画面框选一次倒计时, 两路按相同比例使用该范围; 框选窗口支持放大到当前框, 滚轮缩放和平移. 手动范围会保留, 仅在点击"自动重新寻找"时恢复自动定位.

基础模式在任意一路载入并开始稳定播放后立即预识别, 不必等待另一片源或手动同步. 首次识别的 6 秒和复核的 4 秒都是观察上限, 两路连续跳秒, 新鲜度和播放状态满足要求即可提前结束. 首次同步可使用当前片源仍然新鲜的预识别结果, 跳转后必须重新取得两次连续跳秒.

手动点击自动对齐时, 需要调整就直接跳转, 跳转期间短暂暂停两路并一起恢复, 避免解码等待抵消校正; 只有静默定时同步或播放恢复同步, 且差值小于 2 秒时才允许有限调速, 更严格的已保存阈值仍生效. 跳转后等待两路恢复连续播放, 再复核倒计时, 最多追加两轮校正, 两路速率在完成或取消后恢复正常. 直播补片和缓冲可能延长对齐时间; 若复核时缺少新画面或连续跳秒, 不提示对齐成功. 当前默认复核门限为 0.15 秒, 这是本次识别证据的接受条件, 不代表所有直播源都能达到该精度.

自动寻找区间由应用制作时固定, 正式界面不提供修改入口. 精确手动框优先于寻找区间. 预览中的图像, 图中读数和时间来自同一完整帧, 有效读数与跳秒数分别显示.

自动识别确认后会按片源和画面比例记住范围, 重启后在记忆范围内直接识别并验证跳秒, 无需再次全画面寻找. 手动范围始终优先; 记忆范围未能识别时可重新框选或点击"自动重新寻找". 本地文件以名称, 大小和修改时间区分, 记忆仅保存在本机, 最多保留 64 条.

同一会话内, 片源和清晰度不变时保留已确认的位置, 字形模板和二值化参数. 暂停, 缓冲, 跳转, 变速和取消同步只清除时间证据; 片源, 画面尺寸或识别范围改变后才重新建立相应缓存. 预识别不会更换直播流或清晰度.

<details>
<summary>查看当前自动对齐选项</summary>

<p align="center">
  <img src="./assets/readme/alignment.webp" width="100%" alt="当前自动对齐选项: 明示测试中, 提供定时对齐, 倒计时样式和仅测量入口. 截图使用离线测试片源.">
</p>

</details>

<p align="center">
  <img src="./assets/readme/intake.webp" width="100%" alt="添加直播间界面: 一个输入框接收直播链接或房间号, 下方分别显示画面侧和解说侧的载入状态.">
</p>

斗鱼和虎牙的解说源会尝试同时连接对应房间弹幕. 弹幕延后跟随解说侧的时间调整, 并非逐条识别画面内容; 网络重连, 回放或平台本身的延迟仍可能影响观感.

### 常用操作

| 按键 | 操作 |
| --- | --- |
| `Space` | 播放 / 暂停 |
| `Left` / `Right` | 当前主画面后退 / 前进 5 秒 |
| `Shift + Left` / `Shift + Right` | 当前主画面后退 / 前进 30 秒 |
| `,` / `.` | 回退 / 快进画面, 调整两路相对偏移 |
| `Shift + ,` / `Shift + .` | 使用小步长微调相对偏移 |
| `A` | 尝试自动对齐 |
| `D` / `C` | 切换画面弹幕 / 弹幕侧栏 |
| `F` | 切换全屏 |

相对偏移默认单次调整 `5` 秒, 按住 `Shift` 时微调 `0.5` 秒, 可在设置的通用分区中调整. 回退画面和快进画面按钮同样支持按住 `Shift` 微调. 输入框或对话框获得焦点时, 播放器快捷键不会抢占输入.

## 接入范围

**支持直播播放, 不代表同时支持该平台的弹幕与账号功能.**

| 来源 | 直播或媒体播放 | 弹幕与账号功能 |
| --- | --- | --- |
| YouTube | 直播链接, 支持可用画质选择; 高画质取决于源与网络 | 账号登录用于取流, 未接入聊天弹幕 |
| Twitch | 频道直播 | 未接入聊天弹幕 |
| 斗鱼 | 直播间链接或房间号 | 接收弹幕, 提供账号与房间工具; 写操作需另行开启 |
| 虎牙 | 直播间链接或房间号 | 只读弹幕, 内嵌登录用于取流; 不支持斗鱼式的账号操作与统计 |
| 哔哩哔哩直播 | 直播间链接或房间号 | 内嵌登录用于取流, 未接入弹幕 |
| 抖音直播 | 公开直播间链接, 整段分享文案或选择抖音后输入网页房间号; 支持含 `_` / `-` 的短链接及可用画质选择, 解析后可收藏正式直播间地址 | 接收只读文字弹幕, 可在设置中登录; 不支持发送, 赠礼等账号操作 |
| 媒体直链 / 本地文件 | HLS `.m3u8` 与可解码的视频文件或直链 | 可与另一侧片源组合, 不自带平台账号功能 |

直接粘贴 `.mpd` 的 DASH 链接目前不支持. YouTube 自适应取流由内部流程处理, 不等于通用 DASH 直链支持. 文件扩展名也不保证编码可播放, 仍取决于内置 FFmpeg 和 Chromium 的解码能力.

抖音支持 `live.douyin.com/<网页房间号>` 和 `v.douyin.com` 直播分享. 分享链接中的长场次 ID 与网页房间号不同, 会在确认主播身份后查找当前场次. 取流优先读取公开页面数据, 必要时使用本次新生成的匿名会话读取房间接口, 不执行网页脚本. 直播流进入现有本地缓冲, 支持主画面, 解说, 同屏观看, 画质切换和重新解析; 旧场次即使保留流地址也不会被当作正在直播.

抖音登录位于设置 - 通用 - 抖音, 在应用内统一卡片中扫码或使用短信/密码, 不需要另外安装 Chrome. 验证码与其他安全验证在同一卡片内使用官方组件完成. 应用确认有效登录凭据和官方账号身份后自动关闭卡片, 保存本机登录状态. 卡片输入与官方页面分别运行在隔离视图中, 播放器只接收登录阶段, 不读取密码或验证码. 登录凭据仅用于固定的抖音房间页面和接口, 不发送给媒体 CDN 或弹幕 WebSocket. 匿名状态也会尝试获取直播和弹幕, 需要验证或访问授权的房间仍可能无法载入. 登录或退出后刷新弹幕会话, 视频需要重新载入以使用新的登录状态.

抖音解说源会自动接收当前房间的文字弹幕, 按解说进度延后显示, 支持过滤, 去重, 复制和本地屏蔽; 弹幕连接失败不影响直播播放. 房间面板可手动重连, 增强画中画也可显示同房间弹幕. 暂不接入礼物通知, 不提供抖音弹幕发送, 账号任务或斗鱼式历史统计.

媒体直链支持自定义域名, HTTP/HTTPS 非标准端口和本机/局域网服务. 播放列表可自动读取同源资源及其他公网 CDN; 如其分片或跳转指向另一个本机/局域网服务, 请直接添加该目标的媒体地址. 对本地来源的授权仅适用于选择的 origin, 不扩展到其他主机或端口.

系统代理支持 HTTP, HTTPS 和 SOCKS5, 并保留 PAC 返回的候选顺序. 只有明确的代理连接建立失败才尝试后续候选, 不会自行增加 DIRECT 回退. SOCKS4 会显示不支持提示, 可在代理软件中改用 SOCKS5 或 HTTP. 国内平台仍可在网络设置中选择直连; Fake-IP 地址不会仅因保留网段而被拒绝.

## 使用边界

- **自动对齐仍在测试.** 基础模式仅识别亮字暗底的 `m:ss` 或 `mm:ss` 倒计时, 读数范围为 CS2 正式回合的 `0:01-1:55`, 不判断回合, 比分或比赛阶段, 使用前须确认两路处于同一回合的正式倒计时. 多候选, 字形不清晰或缺少连续递减证据时不调整位置. 不承诺每场比赛均可识别, 也不把内部测试阈值当作真实赛事精度. 可以切换样式包模式并使用倒计时样式编辑器适配位置与数字模板, 手动调整仍是必要的后备方式.
- **对齐通过等待实现.** 应用只能延后较快的一路, 无法让较慢的一路提前到尚未接收到的未来画面. 缓冲不够时需先等待; 多路高画质播放会增加带宽, 内存和解码负担.
- **平台状态会影响取流.** 登录状态, 地区限制, 平台改版和接口风控均可能导致某个来源暂时不可用. YouTube 提示验证身份或内容需要授权时, 请先登录有观看权限的账号. 应用不提供网络线路.
- **账号写操作默认关闭.** 斗鱼设置中的实验性开关控制发送, 赠礼, 续牌及任务等入口. 开启后会使用真实账号执行操作, 可能消耗礼物或余额, 也可能触发平台限制. 关闭开关会隐藏入口, **不会自动停止已经运行的任务**, 应先手动暂停.
- **桌面发布覆盖 Windows x64, macOS x64/arm64 和 Linux x64/arm64.** Windows 提供 NSIS/ZIP, macOS 提供 DMG/ZIP, Linux 提供 DEB/AppImage/tar.gz. 内置精简 FFmpeg 不覆盖全部媒体格式. macOS 最低版本为 13, Linux 构建基线为 Ubuntu 22.04 / glibc 2.35.

登录信息保存在本机. 不要分享含账号资料的应用数据目录. HTTPS 取流会验证服务器证书; 使用会解密 HTTPS 的代理时, 需保证其根证书已正确安装到 Windows 证书库.

<details>
<summary>播放不正常时先检查</summary>

- 无法载入: 确认房间正在直播, 链接属于上表支持的来源, 并检查登录与网络状态.
- YouTube 取流失效: 可在设置的取流工具页面检查和更新 yt-dlp, 或恢复上一版本 / 随包版本.
- 有声音但画面异常: 在通用设置的解码页面尝试软件解码, 按界面提示重启应用后生效.
- 对齐后仍有偏差: 回到手动微调, 重新确认两路是否是同一比分和同一直播片段.

</details>

## 从源码运行

技术栈为 Electron + React + TypeScript, 识别核心使用 Rust / WebAssembly, 并保留 TypeScript 后备实现. 图形界面通过 Electron 启动, 不提供独立的浏览器部署模式.

准备 [Node.js 22.12.0 或更新版本](https://nodejs.org/en/download) 和 [Rust 工具链](https://www.rust-lang.org/tools/install). Windows x64 还需要 Rust 要求的 C++ 构建环境. 以下 Windows 命令使用 PowerShell:

```powershell
git clone https://github.com/Fy1ng/Fy1Sync.git
cd Fy1Sync
npm ci
rustup target add wasm32-unknown-unknown

# Prepare the locked Windows media tools and YouTube token provider.
npm run tools:prepare
$env:STREAM_SYNC_FFMPEG = (Resolve-Path ".packaging/tools/ffmpeg/ffmpeg.exe").Path
$env:STREAM_SYNC_FFPROBE = (Resolve-Path ".packaging/tools/ffmpeg/ffprobe.exe").Path
$env:STREAM_SYNC_YTDLP = (Resolve-Path ".packaging/tools/yt-dlp.exe").Path
$env:STREAM_SYNC_POT_PLUGIN_DIR = (Resolve-Path ".packaging/tools/provider/plugin").Path
$env:STREAM_SYNC_POT_SERVER_HOME = (Resolve-Path ".packaging/tools/provider/server").Path

npm run dev
```

macOS 需要 macOS 13 或更新版本和 Xcode Command Line Tools, 可先运行 `xcode-select --install` 安装. 最低系统版本来自项目固定的 [Electron 44 平台要求](https://github.com/electron/electron/blob/v44.9.3/docs/breaking-changes.md#removed-macos-12-support). 使用与目标 CPU 架构一致的 Node.js, 在 Mac 上重新安装依赖; Apple Silicon 推荐使用原生 arm64 终端. 以下命令使用系统终端的 zsh/bash:

```sh
git clone https://github.com/Fy1ng/Fy1Sync.git
cd Fy1Sync
npm ci
rustup target add wasm32-unknown-unknown

# Build the locked native media tools and prepare the YouTube token provider.
npm run tools:prepare
export STREAM_SYNC_FFMPEG="$PWD/.packaging/tools/ffmpeg/ffmpeg"
export STREAM_SYNC_FFPROBE="$PWD/.packaging/tools/ffmpeg/ffprobe"
export STREAM_SYNC_YTDLP="$PWD/.packaging/tools/yt-dlp"
export STREAM_SYNC_POT_PLUGIN_DIR="$PWD/.packaging/tools/provider/plugin"
export STREAM_SYNC_POT_SERVER_HOME="$PWD/.packaging/tools/provider/server"

npm run dev
```

首次运行会在项目内准备固定版本的 `wasm-bindgen-cli` 并编译 WASM. 上述工具准备过程需要下载构建输入, 可使用后续保留的本地缓存.

macOS 使用左上角原生窗口按钮和系统菜单. 关闭最后一个窗口会结束当前播放并释放后台资源, 应用保留在 Dock, 点击 Dock 图标或菜单中的"显示主窗口"可重新打开; `Cmd+Q` 完全退出. 编辑器支持 `Cmd+Z`, `Cmd+V` 和 `Cmd+Left/Right`, 文本输入保留系统的编辑快捷键. YouTube 登录支持 `/Applications` 或用户 `~/Applications` 中的 Google Chrome.

在对应 Mac 上运行 `npm run package:mac`, 产物位于 `.release/`, 名称为 `Fy1Sync-<version>-mac-<arch>.dmg` 和 `.zip`. `--arm64` / `--x64` 参数只接受当前 Node 的架构, 两个架构分别在对应环境构建. macOS 完整客户端升级使用新的应用包; 应用内手动更新 yt-dlp 会选择官方 macOS Universal 版本. FFmpeg 构建输入, 许可材料, 签名/公证配置和实机验证边界见 [macOS 构建说明](packaging/ffmpeg/README.md#macos-本机构建和打包).


首次运行会在项目内准备固定版本的 `wasm-bindgen-cli` 并编译 WASM. 上述工具准备过程需要下载构建输入, 可使用后续保留的本地缓存.


Linux 需要 Ubuntu 22.04 或更新的兼容桌面系统, 以及与目标 CPU 一致的 Node.js. 构建工具可用以下命令安装:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libgnutls28-dev patchelf libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 libatspi2.0-0 libuuid1 libsecret-1-0 libgbm1 libasound2
npm ci
rustup target add wasm32-unknown-unknown
npm run package:linux
```

产物位于 `.release/`, 文件名为 `Fy1Sync-<version>-linux-<arch>.deb`, `.AppImage`, `.tar.gz`. 工具设置与 macOS 相同, 都使用无 `.exe` 后缀的媒体工具. DEB 声明系统依赖; AppImage/tar.gz 需要本机提供 GTK 3, NSS, ALSA, GBM, GnuTLS 30 等桌面运行库. AppImage 可安装 FUSE 2 或使用 `--appimage-extract-and-run`. 解压运行包仍使用系统的用户数据目录.

发布流程见 [.github/workflows/release.yml](.github/workflows/release.yml). 推送与 `package.json` 版本相同的 `v<version>` 标签后, CI 先在单个任务中准备队标以保证请求间隔, 再分别在 Windows x64, Mac Intel, Mac Apple Silicon, Linux x64 和 Linux arm64 原生 runner 上构建. 完整的 12 个包均通过校验和打包应用启动检查后才发布 GitHub Release 与 `SHA256SUMS.txt`. 手动运行工作流只构建和保留 Actions 产物.

macOS 当前未配置 Developer ID 签名或公证, 首次打开可能需要在系统安全设置中确认来源. 原生 CI 检查覆盖构建主机上的启动, 媒体工具和归档内容, 不代表所有系统版本和硬件均完成实机验收.

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 构建 WASM, 检查类型, 构建前端与 Electron 主进程 |
| `npm run configure:clock-search` | 启动独立制作工具, 一次设定生产寻找区间 |
| `npm start` | 启动已构建的桌面应用 |
| `npm test` | 运行单元测试 |
| `cargo test --workspace` | 运行 Rust 测试 |
| `npm run test:e2e` | 运行 Electron 端到端测试 |
| `npm run package:linux` | 在原生 Linux x64/arm64 主机上构建并检查 DEB/AppImage/tar.gz |
| `npm run package:smoke` | 使用隔离目录启动并检查当前平台的打包应用 |
| `npm run package:win` | 准备工具并构建 Windows x64 安装包与免安装包 |
| `npm run package:mac` | 在 Mac 上准备原生工具, 构建当前架构 DMG/ZIP 并检查内容 |
| `npm run package:check` | 按当前平台检查本地打包结果 |
| `npm run package:check:mac` | 在 Mac 上复验当前架构的应用包和工具 |
| `npm run test:packaging` | 运行打包平台选择, Mach-O 和归档校验的离线测试 |

端到端测试默认以 Electron 离屏渲染隐藏主窗口和增强画中画, 静音运行, 不抢占桌面焦点. 离屏模式保持视频帧和动画推进, 不依赖屏幕上的可见窗口. 依赖原生全屏, 窗口按钮或真实前台焦点的专属测试默认跳过; 只有显式设置 `STREAM_SYNC_E2E_VISIBLE=1` 才显示测试窗口并运行这些项目. 测试资料始终使用隔离目录. 可用 `npm run test:e2e -- e2e/hidden-windows.spec.ts` 检查隐藏窗口下的界面, IPC 和画中画运行.

制作工具只读取本地样例录像, 不运行识别. 框选并点击"写入生产配置"后保存到 `src/recognition/basicSearchRegion.json`, 后续构建固定使用该区间. 写入后工具锁定, 如需重新制作可运行 `npm run configure:clock-search -- --reset`. 工具和写入接口不会打包进正式应用.

`src/studio/` 是观赛界面, `src/sync/` 管理对齐流程, `crates/core/` 实现识别算法, `electron/` 管理桌面能力, `server/platforms/` 和 `server/danmaku/` 负责平台接入. 贡献前请阅读 [AGENTS.md](https://github.com/Fy1ng/Fy1Sync/blob/main/AGENTS.md), 使用隔离的测试资料, 避免触碰真实账号数据或执行真实账号操作.

## 许可与致谢

Fy1Sync 按 [GPL-3.0-or-later](https://github.com/Fy1ng/Fy1Sync/blob/main/LICENSE) 发布. FFmpeg, yt-dlp, PO token provider 和字体等组件保留各自许可, 详见 [第三方声明](https://github.com/Fy1ng/Fy1Sync/blob/main/packaging/THIRD-PARTY-NOTICES.md); 发布包内也提供相关许可与源码材料.

CS2 赛程信息来自 [Liquipedia](https://liquipedia.net/counterstrike/Liquipedia:Matches), 按 [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) 使用. 战队名称与队标的权利属于各自权利人.
