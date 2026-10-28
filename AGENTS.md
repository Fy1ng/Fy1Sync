# Fy1Sync 项目约束

- 这是 Fy1Sync 的独立仓库。主工作区是本目录（分支 `main`），界面工作区是同级目录 `../Fy1Sync-ui`（分支 `ui-redesign`，同一仓库的 worktree）。不要再在旧的 DouyuPlus1 子目录或 `DouyuPlus1-ui` 里开发。
- 回复、文档、界面文案用中文；代码注释、标识符用英文。见 `CLAUDE.md`。
- `docs/` 和 `.local-handoff/` 只在本地保留，已被 `.gitignore` 忽略，不要提交或强制添加。交接文档在 `.local-handoff/`。
- 测试数据只用临时目录和 `e2e/.data`。不读写、复制或迁移真实的 `%APPDATA%\Stream Syncer` / `%APPDATA%\Fy1Sync`。
- 不做真实账号写操作：发送弹幕、赠礼、签到、禁言、续牌等。
- 不提交、不推送、不做 git 写操作，除非这次任务明确要求。
- 发往 liquipedia.net 的请求：任意两次至少间隔 2 秒，`action=parse` 至少间隔 30 秒。User-Agent 为 `Fy1Sync/<版本> (local desktop app; sync@fy1ng.cn)`。
- 提交作者为 `Fy1ng <dev@fy1ng.com>`，仓库本地配置已设置。
- 临时文件放 `.runtime-cache/`。
