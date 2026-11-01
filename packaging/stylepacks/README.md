# 赛事样式包云端分发

样式包是现有 `hud-style-pack` JSON 数据, 包含画面区域, 字形和状态模板. 用户安装一次支持此功能的客户端后, 后续同一格式和识别能力范围内的赛事包可独立发布, 无需重新下载安装包. 新的识别算法, WASM 能力或不兼容的样式格式仍需要客户端升级.

客户端启动后自动检查, 运行期间每 6 小时检查, 也支持手动同步. 仅下载新增或内容发生变化的包. 云端包保存在独立缓存中, 不覆盖本机预设. 下载, 签名或格式校验失败时继续使用旧版本. 正在同步的会话保留已加载版本, 下次选择或新会话再使用更新后的包.

## 首次设置

1. 在公开发布目录之外选择私有目录, 显式生成 Ed25519 发布密钥:

   ```powershell
   node scripts/stylepack-release.mjs keygen --out C:/private/fy1sync-stylepack-signing
   ```

   该目录会得到 `private-key.pem` 和 `public-key.spki.txt`. 已存在的密钥不会被覆盖. 私钥不输出到终端, 不进入公开目录, 不打包到客户端, 不提交到 Git. Windows 上请使用只有发布人员可访问的私有目录和系统文件权限保护它.

2. 在现有 HTTPS 服务器, CDN 或对象存储上确定固定的清单地址, 例如 `https://assets.example.com/fy1sync/stylepacks/manifest.json`. 云端只需托管静态文件, 无需新增业务服务器或数据库.

3. 将 `packaging/stylepack-source.json` 从 `null` 改成下列公开配置后再构建客户端:

   ```json
   {
     "manifestUrl": "https://assets.example.com/fy1sync/stylepacks/manifest.json",
     "publicKey": "public-key.spki.txt 中的单行 Base64 公钥"
   }
   ```

   这里的域名仅为说明示例. 当前默认配置是 `null`, 因为尚未指定真实托管地址和发布公钥. 未配置时客户端显示未配置, 不会假装已连通云端. 客户端公钥必须在首次发布支持该功能的安装包前确定. 更换发布密钥或可信源应更新客户端的可信配置.

## 制作后续发布

输入目录只放本次完整目录中需要保留的正式赛事包 JSON. 每个包必须先完成既有的独立比赛逐帧验收并正式导出; 此工具的结构校验和签名不替代识别准确率验收, 不应直接分发草稿或素材工程.

编辑器顶部的 `只读批量验收` 可对当前录像的指定区间进行抽样检查. 开始时固定整个样式包快照, 使用播放器的自动布局选择和相同 Rust/WASM 识别入口, 不修改模板. 默认每秒一帧, 可选择 0.5/1/2/5 秒间隔, 单次最多 7200 帧, 不采样结束时刻. 疑点和状态切换分别列出, 点击结果查看原始画面或跳回录像, 停止后保留已完成部分. 验收报告仅留在当前编辑器会话, 更换录像或重开页面后清除. 读取成功率和连续性检查不是准确率, 抽样也可能遗漏短暂事件; 发布前仍应使用未参与训练的比赛复核疑点并抽查正常结果.

```powershell
node scripts/stylepack-release.mjs prepare `
  --input C:/release-input/validated-stylepacks `
  --out C:/release-output/stylepacks `
  --key C:/private/fy1sync-stylepack-signing/private-key.pem `
  --manifest-url https://assets.example.com/fy1sync/stylepacks/manifest.json `
  --revision 1
```

输出为 `manifest.json` 和 `packs/<sha256>.json`. 输出只含公共数据文件, 不含私钥. 工具复用生产样式包和签名清单校验器, 校验大小, 格式, 重复 ID 和版本连续性. 相同内容使用确定的 JSON 序列化, 因而保留相同文件名与 SHA256, 客户端可以跳过下载.

下一次发布提高清单 `--revision`. 修改某个包时, 还必须提高该 JSON 内部的 `revision`. 未变化的包保留原 revision 和内容. 使用已有输出目录时会自动验证其中的旧签名清单; 输出到新目录时, 用 `--previous <旧 manifest.json>` 显式关联前次发布, 防止误降级或同版本修改内容. 旧签名须由同一私钥对应的公钥验证通过.

新包或提高 revision 的包默认 `minAppVersion` 为当前项目版本, 未变化的包保留先前的最低版本要求. `--min-app-version <版本>` 可显式设置这批包所需的最低客户端版本, 改动该要求时也需要提高包 revision. 无法使用新包的旧客户端会保留已有兼容版本. 一个发布目录是一份完整清单, 缺席的条目表示从云端目录撤回. 如要撤回全部云端包, 必须额外使用 `--allow-empty`, 防止误选空目录导致清空目录.

## 上传顺序与缓存

先上传全部 `packs/` 文件, 验证文件可从指定 HTTPS 源读取, 最后原子替换 `manifest.json`. 包文件内容寻址且不可覆盖, 适合长时间 CDN 缓存; 清单应关闭长期缓存或使用短期缓存并正确提供 ETag. 保留旧包文件一段时间, 使已读取旧清单的客户端仍能完成下载.

清单使用 Ed25519 签名, 签名覆盖 Base64 解码后的原始 UTF8 payload 字节. 客户端固定信任公钥, 并验证清单版本, 包 SHA256, 精确字节数, ID, revision 和现有严格格式. 每个包上限 2 MiB, 清单最多 128 包, 签名清单上限 256 KiB. 下载路径固定为同源同目录下的 `packs/<sha256>.json`, 不接受重定向或远程脚本.

工具只生成本地分发文件, 不进行上传, Git 推送或真实云端部署. `node scripts/stylepack-release.mjs --help` 显示命令说明.
