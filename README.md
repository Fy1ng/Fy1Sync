# Fy1Sync 应用在线更新清单

`app-updates` 是独立的公共签名更新分发分支，不包含应用源码历史、安装包二进制或发布私钥。

## 当前状态

- 清单 revision：`1`
- 最新 Windows x64 安装版：`0.6.0`
- 已收录下载镜像：`github`

客户端通过内置公钥校验 `manifest.json` 的 Ed25519 签名与版本号，再按各镜像的精确来源白名单与 SHA-256 流式下载验证安装包或前端资源包，不依赖代码托管平台登录态。

## 分发文件

```text
manifest.json
history/
  <revision>-<payload-sha256>.json
frontends/            # 仅在发布独立前端更新时存在
  <sha256>.json
```

- `manifest.json` 是最新签名目录，GitHub 与 GitCode 镜像保持字节一致。
- `history/` 保存不可变签名历史记录，防止版本号或内容回退。
- Windows 安装包（`.exe`）作为 Release 附件分发，不提交到本 Git 分支。

## 镜像

- [GitHub](https://github.com/Fy1ng/Fy1Sync/tree/app-updates)
- [GitCode](https://gitcode.com/Fy1ng/Fy1Sync/tree/app-updates)
