# 应用在线更新发布

应用更新分为两个代码通道, 与现有赛事样式包, 赛程和队标等数据更新分开:

- 前端更新包括已构建的 React, CSS, 字体, 图标, Worker 和接口兼容的 WASM. 下载并验证后, 当前会话继续使用原版本, 下次启动切换. 用户也可明确选择重启应用. 启动健康检查未完成时自动恢复前一可用版本.
- 完整应用更新用于 Electron, 主进程, preload, IPC 能力, 原生依赖, 权限或安装资源的变更. 先在应用内下载校验, 用户明确确认后退出并打开现有 Windows x64 安装向导. 不静默执行安装包, 不提权安装, 不为便携版或开发实例冒充已安装版升级.

用户必须先安装一次包含更新机制的客户端. 此前的安装包只会检查版本, 不能通过发布前端资源为旧主进程补出新的下载, 验签或安装能力. 当前实现不执行仓库最新 JavaScript, 不远程替换主进程, 不为任何更新新增系统全局快捷键.

## 信任与兼容边界

`packaging/frontend-build.json` 记录内置前端 revision 和 `bridgeVersion`. IPC 的能力或语义发生不兼容变化时提高 `bridgeVersion`, 并通过完整安装包发布. 前端包必须与主进程的 `bridgeVersion` 精确相等, 且客户端版本必须处于签名清单的 `minAppVersion` 到 `maxAppVersion` 范围内, 两端均包含.

前端兼容范围默认固定为制作时的项目版本, 不自动假设未来客户端兼容. 只有已验证多个客户端版本时才扩大范围. 保持前端 revision 和清单 revision 独立递增, 不复用已失败, 撤回或回退的 revision. 前端包不能包含主进程和 preload 文件; 改识别 WASM 时应将配套 JavaScript 与 WASM 一起构建和验收.

应用代码更新使用独立 Ed25519 公钥, 不复用赛事样式包的数据发布密钥. 签名覆盖 payload 原始 UTF8 字节, 哈希和精确字节数覆盖整个前端包或安装包. 客户端只选择内置 GitHub/GitCode 来源 ID, 不能由前端更改公钥或任意指定下载地址. 两源共用同一份清单和签名, 镜像滞后不能导致降级, 下载失败也不静默切源.

每跳下载都要求 HTTPS, 公开 DNS 地址和精确来源白名单. 直连会固定已校验的 IP. 用户显式配置的系统 HTTP 代理沿用现有网络策略, 代理端负责实际 DNS 解析, 客户端无法将本地解析结果固定到代理的出站连接. 不会因更新偷偷关闭用户代理或放宽到任意重定向来源.

## 首次密钥与分发源准备

本工具不联网, 不创建远端分支, 不上传文件, 不执行 Git 命令或安装包. 代码实现完成不代表公共更新源已有发布内容.

如果主代理已为本次实现配置专用应用发布密钥, 后续直接复用, 不重复生成. 尚未配置时, 在仓库和公开目录之外显式创建:

```powershell
node scripts/online-update-release.mjs keygen --out C:/private/fy1sync-application-signing
```

生成 `private-key.pem` 和 `public-key.spki.txt`, 不覆盖已有密钥, 不把私钥输出到终端. Windows 下需使用仅发布人员和 SYSTEM 可访问的目录 ACL; POSIX 的文件 mode 不能替代 Windows ACL. 私钥不能提交, 上传, 放进更新目录或打包进应用, 也不能粘贴到工单和日志.

来源配置仅包含公开镜像地址和该专用公钥:

```json
{
  "mirrors": [
    { "id": "github", "manifestUrl": "https://raw.githubusercontent.com/Fy1ng/Fy1Sync/refs/heads/app-updates/manifest.json" },
    { "id": "gitcode", "manifestUrl": "https://raw.gitcode.com/Fy1ng/Fy1Sync/raw/app-updates/manifest.json" }
  ],
  "publicKey": "public-key.spki.txt 中的单行 Base64 公钥"
}
```

将配置保存为客户端实际使用的公开来源配置, 制作时通过 `--source` 传入. 发布工具核对公私钥匹配, 并拒绝使用当前赛事样式包公钥. 上述 `app-updates` 地址是预定静态分发位置; 首次创建或推送分支仍需单独明确授权. 两站未发布时, 检查更新失败是未上线状态, 不能宣称客户端已是最新版本.

## 前端更新

先运行项目要求的类型检查, 测试和完整构建. 用已构建的 `dist/client` 制作, 不直接分发 `src`, `electron` 或整个工作区:

```powershell
npm run build
node scripts/online-update-release.mjs prepare `
  --client dist/client `
  --revision 2 `
  --catalog-revision 1 `
  --source packaging/online-update-source.json `
  --key C:/private/fy1sync-application-signing/private-key.pem `
  --out .runtime-cache/application-release `
  --notes C:/release-input/frontend-notes.txt
```

来源文件名以仓库实际配置为准. `--frontend-version` 默认为项目版本; 真正判断新旧的是独立前端 revision. `--min-app-version` 和 `--max-app-version` 默认都为项目版本. 新前端 revision 必须高于内置版本和提供的历史前端版本. 若只有原样保留旧前端, 省略 `--client` 和所有前端参数, 不必重制和提高前端 revision.

输出包括 `manifest.json`, `frontends/<sha256>.json` 和 `history/<revision>-<payload-sha256>.json`. 前端包是有界的 JSON 静态资源容器, 不是可包含任意路径或链接的 ZIP. 只收录 `index.html` 和 `assets/` 内允许的静态文件, 不包含 source map, 测试视频, `.env`, 私钥或其他根目录文件. 工具还检查 HTML 入口和静态资源引用完整性, 但不能替代真实 Electron 启动, 交互, 识别和回滚验收.

使用已有输出目录会自动验证其中的签名清单, 不可变签名历史和内容寻址文件. `history/` 内每个文件都必须由同一应用公钥验签通过, 文件名同时绑定清单 revision 和原始 payload 的 SHA256. 记录只有公开清单和签名, 不含私钥; 不接受没有签名的裸最高版本数字. 撤回通道不会忘记此前的最高版本, 撤回后重新发布必须使用更高的前端 revision 或应用版本, 即使字节完全相同也不能复用旧版本.

新输出目录通过 `--previous <旧目录/manifest.json>` 关联前次发布, 工具自动验证并继承旧目录的完整 `history/`, 旧目录还必须保留需要继续分发的前端资源. 未指定通道以当前最新 `manifest.json` 为准保留, 不会从历史中把已撤回通道重新启用. 单独已有最新签名清单而没有 `history/` 的基线可导入该清单, 但工具无法推断用户删除掉的更早记录. 发布目录和历史应一起备份, 不要删除历史或只搬运最新清单来绕过版本校验.

签名历史在资源与最新清单发布前落盘. 如果后续复制安装包或写入最新清单失败, 已持久化的签名版本仍视为预留, 重试需使用更高的清单和相应通道版本. 工具不会因准备失败就默默复活尚未启用的历史通道; 如保留的当前通道与更高预留版本冲突, 应重新准备更高版本或显式撤回. `history/` 最多 1024 条, 单条最多 256 KiB, 总大小最多 64 MiB. 达到上限会停止签名, 不会自动删除历史; 换输出目录也必须继承已有记录, 不能借此重置计数.

## 完整应用更新

使用项目现有 Windows NSIS 构建和安装验证流程生成正式 `.exe`, 并准备不含哈希的描述文件:

```json
{
  "version": "0.3.0",
  "platform": "win32",
  "arch": "x64",
  "notes": "完整应用更新的说明.",
  "downloads": {
    "github": {
      "url": "https://github.com/Fy1ng/Fy1Sync/releases/download/v0.3.0/Fy1Sync-0.3.0-win-x64-nsis.exe",
      "redirectOrigins": ["https://release-assets.githubusercontent.com"]
    },
    "gitcode": {
      "url": "https://downloads.example.com/replace-with-verified-gitcode-asset-url.exe",
      "redirectOrigins": []
    }
  }
}
```

GitCode 的示例地址不能用于实际发布. 上传附件后填入实际可匿名下载的 HTTPS 地址, 只列实测必要的精确重定向 origin, 不使用通配符或带账号, token 的 URL. 每个来源只使用自己的条目, 不把 GitCode 来源隐式转到 GitHub. 所有镜像必须返回同一个安装包字节序列.

```powershell
node scripts/online-update-release.mjs prepare `
  --application C:/release-input/application.json `
  --installer .release/Fy1Sync-0.3.0-win-x64-nsis.exe `
  --catalog-revision 2 `
  --source packaging/online-update-source.json `
  --key C:/private/fy1sync-application-signing/private-key.pem `
  --out .runtime-cache/application-release
```

该命令保留上次的前端通道. 若完整客户端升级后旧前端包不再合适, 使用 `--drop-frontend` 显式撤回, 或同一命令提供新构建的前端和新 revision. 工具检查 PE 文件头, 流式计算 SHA256 和大小, 将安装包写到 `installers/<sha256>.exe`, 不把整个大安装包载入内存. 描述中的版本, 下载地址, 说明或安装包字节有变化时都应提高应用版本, 不改写已签名的同版本发布.

安装包最高 1 GiB, 前端分发文件最高 48 MiB, 解码后静态资源最高 32 MiB, 单文件最高 16 MiB, 最多 512 个资源, 签名清单最高 256 KiB. 安装包通常不适合放进 Git 分支, 应作为 Release 附件或受控静态下载服务上的文件. `installers/` 是本地交付输出, 不代表应把它提交到源码或静态清单分支.

## 发布, 撤回与验收

1. 使用隔离的本地测试数据验证新前端正常启动, 功能正常, 旧客户端拒绝不兼容包, 坏签名或错误哈希被拒绝, 缺资源或未通过健康检查时自动回退. 完整安装包需另外完成安装, 升级和卸载验收, 单元测试不能代替安装测试.
2. 做源码和待分发构建的安全与隐私检查. 工具的路径白名单和签名校验不能证明代码不存在逻辑漏洞或所有形式的秘密.
3. 获得发布授权后, 先上传前端内容寻址文件和两站安装附件, 逐源下载核对 SHA256 和字节数. 不覆盖已发布的内容寻址文件.
4. 确认两源都能读取资源后, 最后更新同一份 `manifest.json`. 清单使用短缓存或重新验证, 资源文件可长缓存. 保留旧文件, 让已拿到旧清单的用户能完成下载.
5. 在应用中分别选择 GitHub/GitCode 并手动检查, 验证新旧版本, 兼容性, 下载, 重启或安装提示. 下载过程不应中断播放, 更换来源不应自动开始下载.

撤回单个通道时省略该通道制作参数并添加 `--drop-frontend` 或 `--drop-application`, 同时提高清单 revision. 省略通道本身表示保留, 不是删除. 撤回清单阻止新下载, 不远程删除用户已装版本或本地草稿. 已经安装的问题前端由客户端回退, 后续修复必须用更高的前端 revision 发布. 不为回滚整体应用默默降低安装版本.

`node scripts/online-update-release.mjs --help` 可查看参数. 此工具始终只准备本地分发文件, 不自行推送源码或发布更新.
