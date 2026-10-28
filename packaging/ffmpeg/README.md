# FFmpeg 独立构建

本目录锁定精简 LGPL 共享库构建, 不参与 `tools:prepare`. 构建入口不上传, 不更新消费侧工具锁, 不改产品代码.

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
