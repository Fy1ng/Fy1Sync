# Fy1Sync 项目约束

- 这是 Fy1Sync 的独立仓库。主工作区是本目录（分支 `main`），界面工作区是同级目录 `../Fy1Sync-ui`（分支 `ui-redesign`，同一仓库的 worktree）。不要再在旧的 DouyuPlus1 子目录或 `DouyuPlus1-ui` 里开发。
- 回复、文档、界面文案用中文；代码注释、标识符用英文。见 `CLAUDE.md`。
- 文档目录为 `docs/`，交接文档在 `.local-handoff/`。
- 测试数据只用临时目录和 `e2e/.data`。不读写、复制或迁移真实的 `%APPDATA%\Stream Syncer` / `%APPDATA%\Fy1Sync`。
- 不做真实账号写操作：发送弹幕、赠礼、签到、禁言、续牌等。
- 远程默认只推 `main`.
- 每次新版完成推送和安装包发布后, 使用本次已验证的 NSIS 安装包覆盖升级本机现有的 NSIS 安装, 沿用原安装目录并保留用户数据, 不因已安装旧版而跳过. 完成后核对卸载项版本及安装目录内应用资源与发布包一致. 实际升级与可丢弃环境的安装/卸载测试分开, 不卸载日常安装, 不读取或迁移真实账号数据.
- 发往 liquipedia.net 的请求：任意两次至少间隔 2 秒，`action=parse` 至少间隔 30 秒。User-Agent 为 `Fy1Sync/<版本> (local desktop app; sync@fy1ng.cn)`。
- 临时文件放 `.runtime-cache/`。
