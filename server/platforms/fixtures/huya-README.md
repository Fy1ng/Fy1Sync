# 虎牙测试夹具

`huya-biliup-golden.json` 的 request/response 是 biliup 测试原始字节, 并非本项目编解码器自行生成. 来源: [huya_wup.rs](https://github.com/biliup/biliup/blob/48a0d234794bb918e211076b357823438e8c109d/crates/biliup/src/downloader/live/huya_wup.rs#L405), commit `48a0d234794bb918e211076b357823438e8c109d`, 读取日期 2026-10-27. 上游测试注明由移植前 Python TARS 实现生成, 请求使用固定虚构流名和 UA, 响应使用 `abc123` 测试签名. MIT, Copyright (c) 2019 ForgQi, 完整许可保存在 [huya-biliup-LICENSE.txt](huya-biliup-LICENSE.txt).

`huya-*.html` 是按当前页面字段结构人工构造的脱敏最小页面, 不包含真实用户, Cookie, 有效签名或远端脚本. 房间与流身份都是测试数据.

本地签名算法参考同一版本的 [huya.rs](https://github.com/biliup/biliup/blob/48a0d234794bb918e211076b357823438e8c109d/crates/biliup/src/downloader/live/huya.rs), 未使用 Simple Live 代码. 协议子集只包括 TarsV3 RequestPacket, map<string, bytes>, HUYA.GetCdnTokenExReq, HUYA.UserId 和 HUYA.GetCdnTokenExRsp 的必要字段.
