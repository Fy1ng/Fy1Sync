# Fy1Sync 赛事样式包

`style-packs` 是独立的公共分发分支, 不包含应用源码历史, 本机工程或录像素材.

## 当前状态

本分支已初始化, 尚未发布正式样式包或签名清单. 应用接入真实分发地址和发布公钥后, 才能同步这里的已签名内容.

## 分发文件

```text
manifest.json
packs/
  <sha256>.json
```

- `manifest.json` 是签名目录, 列出当前正式提供的全部样式包.
- `packs/<sha256>.json` 是按内容哈希命名的样式包, 文件内容不可原地修改.
- GitHub 和 GitCode 镜像应上传同一份生成结果, 保持签名和文件字节一致.
- 发布工具使用独立输出目录, 再将生成的清单和包文件复制到本分支.
- 先上传包文件, 确认可以读取后再更新清单, 不在公开分支保存发布私钥或访问令牌.

此分支只用于用户下载, 不接收客户端自动上传的草稿. 制作, 验收和签名发布在维护者本机完成.

## 镜像

- [GitHub](https://github.com/Fy1ng/Fy1Sync/tree/style-packs)
- [GitCode](https://gitcode.com/Fy1ng/Fy1Sync/tree/style-packs)
