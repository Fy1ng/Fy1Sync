# FFmpeg 独立构建

本目录锁定精简 LGPL 共享库构建. Windows 保留独立构建入口, macOS 的 `tools:prepare` 在缺少当前架构的本地 FFmpeg 输出时调用原生构建. 构建入口不上传, 不更新已验证的 Windows 消费侧工具锁, 不改产品代码.

在 Windows x64 和 Node.js 24.15.0 下运行:

```powershell
npm run ffmpeg:build
```

所有下载位于 `.packaging/ffmpeg-build/downloads/`. 缓存必须精确匹配锁内 size/SHA256, 损坏时失败且不覆盖. 下载仅使用锁内 URL, 系统 curl 支持环境代理. 系统 tar 用于初始解包, 其余构建工具从锁定归档展开. Node 版本也固定, 避免内置 zstd/deflate 实现差异.

默认构建位置为 `C:/fy1-ffmpeg-release/<buildId>/`, 输出为 `.packaging/ffmpeg-build/out/<buildId>/`. 构建和输出目录必须不存在. 已有目录不会删除或复用. 临时下载和执行记录位于新的 `.runtime-cache/codex-ffmpeg-build-*`.

第二次完整构建示例:

```powershell
node scripts/build-ffmpeg.mjs --build-root C:/fy1-ffmpeg-rebuild/<buildId> --output-dir .runtime-cache/codex-ffmpeg-build-<new-id>/rebuild-out
```

`--work-dir` 可指定新的临时工作目录, 必须位于仓库 `.runtime-cache/`. `--download-only` 只下载并校验输入. 中性路径只允许 `C:/fy1-ffmpeg-<neutral-name>/<buildId>`, 不允许空格或用户目录.

能力集合沿用获批候选, 额外锁定 x86-64 CPU 基线并禁用 PE 链接时间戳. zlib 1.3.2 使用静态 `libzs.a`, 复制为私有前缀的 `libz.a` 供 FFmpeg 查找. FFmpeg 自身为共享库, GCC runtime 和 winpthreads 静态链接. configure 使用相对路径; make 和 install 均显式传 REVISION.

入口断言配置宏, 全部外部库, 完整能力集合, 精确版本/ABI/configure, LGPL 2.1+, TLS 默认校验, PE 普通及延迟导入, 固定 PE 时间戳和私人路径缺失. 此工具链 strip 后的 PE 时间戳为 SOURCE_DATE_EPOCH, 入口精确核对该值. 固定版本不支持 `-parsers`, 因此编译小型公共 API 探针调用 `av_parser_iterate`; 探针不进入运行归档.

运行归档只含 7 个运行文件. 源码材料归档含三个原始源码包, 补丁, 锁, 构建和冒烟脚本, 配置附件, 版本/许可/能力输出及许可原文. `build-manifest.json` 记录逐文件和归档的 size/SHA256 及工具链身份. ZIP 按文件名排序, 时间戳固定为 SOURCE_DATE_EPOCH, 不保留宿主文件时间.

本地冒烟见 `scripts/ffmpeg-smoke/README.md`. 构建日志位于中性构建目录的 `logs/`. 失败目录和下载临时文件保留供诊断; 本入口不做清理.

## macOS 本机构建和打包

在 macOS 13 Ventura 或更高版本的 arm64 或 x64 本机安装 Xcode Command Line Tools, Node.js/npm 和项目构建所需的 Rust/wasm 工具, 然后在同一架构的 Node 下运行. [Electron 44 的官方最低系统要求](https://github.com/electron/electron/blob/v44.9.3/docs/breaking-changes.md) 为 macOS 13. 建议使用 Node.js 24.15.0. 不复制 Windows 的 `node_modules` 或 `.packaging/tools` 到 Mac.

```sh
xcode-select --install
npm ci
npm run ffmpeg:build
npm run tools:prepare
npm run package:mac
```

`package:mac` 完成工具准备, 队标准备, 项目构建, 最小应用预备, electron-builder DMG/ZIP 生成和包内容检查. `npm run package:mac -- --arm64` 或 `--x64` 只接受当前 Node 的同一架构, 不交叉编译或生成 universal 包. 包名为 `Fy1Sync-<version>-mac-<arch>.dmg` 和 `.zip`. `npm run package:check:mac` 可复验当前架构产物, `npm run package:check` 会按宿主平台分流. 包检查报告写入 `.runtime-cache/check-package-mac-*/`.

macOS FFmpeg 直接读取原有 `build-lock.json` 中的 FFmpeg commit, zlib 1.3.2 源码及有序 TLS 补丁, 每项核对原有 size/SHA256. 只下载这两个固定源码输入, 不使用 Homebrew 或 PATH 内的 FFmpeg, 不下载 Windows 工具链. `--download-only` 可只校验缓存和源码. 官方 `yt-dlp_macos` 的固定版本, size 和 SHA256 单独记录在 `packaging/tools-mac-lock.json`; 它在包内命名为 `tools/yt-dlp`. provider 沿用原始源码, 固定插件和 patched npm lock, 使用 `npm ci --omit=dev --ignore-scripts`, 保留完整匹配源码和许可.

原生构建只调用 `/usr/bin/clang`, make, ar, ranlib, patch, tar, curl, otool 及 Apple SDK 工具. zlib 静态编译并执行 `make test`, FFmpeg 继续采用 LGPL 2.1+ 共享库. 媒体组件集合沿用锁内配置. HTTPS 使用 macOS Secure Transport 和系统信任库, 并保留证书默认校验补丁. Secure Transport 不提供 DTLS, 所以 macOS 明确不启用 Windows Schannel 自动带入的 `dtls` 和 `udp`; 应用使用的 HTTP/HTTPS/HLS 不受影响. 两种 CPU 均关闭汇编以使用系统 clang 完成基线构建, 避免额外引入未锁定的 NASM; 不开启 GPL/nonfree/version3 或其他自动探测库.

`packaging/tools-mac-lock.json` 将最低系统版本固定为 `13.0`, electron-builder 使用同一字段写入应用的 `LSMinimumSystemVersion`. 所有 zlib/FFmpeg configure, make 和 clang 探针均继承 `MACOSX_DEPLOYMENT_TARGET=13.0`; zlib 的 `CFLAGS`/`LDFLAGS` 和 FFmpeg 的 `--extra-cflags`/`--extra-ldflags` 还明确指定 `-mmacosx-version-min=13.0`, 避免构建机器的较新系统版本隐式提高运行要求. 每个 FFmpeg 运行文件的 Mach-O 最低系统版本由 `otool -l` 读取并核对为 13.0, 实际 load commands 保留在源码材料证据中.

运行目录仅包含 `ffmpeg`, `ffprobe` 和 5 个 ABI 主版本命名的 `.dylib`, 每个文件都是当前架构的 Mach-O 常规文件. dylib install name 为 `@rpath/lib<name>.<major>.dylib`, 可执行文件 rpath 为 `@executable_path`, 运行文件移动到应用资源目录后再检查依赖和执行 PNG/GIF, MP4 copy/ffprobe 冒烟. 入口还检查配置宏, 全部外部库, 精确能力集, 公共 API parser iterator, 版本, ABI, LGPL 许可, TLS 默认校验及私有路径缺失. 不依赖构建机的安装前缀, Homebrew dylib 或全局环境变量.

下载仍位于 `.packaging/ffmpeg-build/downloads/`. 原生输出位于 `.packaging/ffmpeg-build/out/<buildId>-mac-<arch>/`, 包含 runtime tar.gz, source tar.gz 和逐文件/归档 SHA256 manifest. manifest 记录最低系统版本, 传入的原生构建环境, 工具链与逐运行文件的最低版本证据. 工具准备校验 source lock, mac lock, 13.0 系统基线, 补丁, 配置, 能力和归档, 再执行原生冒烟; 缺少此信息或使用其他最低系统版本的旧缓存必须重新构建. 输出目录存在时独立构建命令拒绝覆盖; `tools:prepare` 会校验并复用. 工作目录和日志位于新的 `.runtime-cache/ffmpeg-mac-*/`, 失败材料保留. 若需要重新编译, 先将旧架构输出手动移到另一备份目录. 其他架构的输出和 Windows 缓存保持独立.

source tar.gz 包含原始 FFmpeg/zlib 源码, 原始许可, 补丁, 两个锁, macOS 构建脚本, 实际配置和验证证据. 解压材料后可运行 `node scripts/build-ffmpeg-mac.mjs`; 脚本优先校验并复用归档中的 `upstream/` 源码. Apple clang/SDK/macOS/Node 版本记录在 manifest 中. 系统工具链和 tar 元数据随主机而变, 不宣称 macOS 构建跨机器字节可复现, 不生成虚构的远程 FFmpeg 资产或固定二进制 hash.

本地打包使用 electron-builder 的正常签名/公证环境变量, 不伪造 Developer ID. 未配置证书时产物用于本地评估. 配置正式证书时, 原始工具下载/编译 hash 仍保留; inventory 额外记录移除 Mach-O 签名后的 hash. 包检查只在 `codesign --verify --strict` 成功且移除签名后的 payload 完全一致时接受签名变化. 检查会从最终 `.app` 内执行 FFmpeg/ffprobe 媒体冒烟和 yt-dlp 版本验证. Mac ZIP 检查在提取前核对路径, 链接和边界, 并对照完整 `.app` 文件, 权限和 Framework 链接; DMG 先使用 `hdiutil verify`, 再只读挂载到本次临时目录对照相同的 `.app` 内容, 不打开 Finder 或安装应用, 完成后卸载卷.

当前 Windows 环境只验证离线平台分流, 锁和配置, Mach-O 元数据与归档检查单测. Apple clang 原生编译, Secure Transport 实际加载, DMG/ZIP 构建和可选签名/公证仍需在对应 macOS 实机验证. 可运行 `npm run test:packaging` 复验跨平台离线检查.
