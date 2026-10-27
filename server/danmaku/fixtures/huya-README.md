# 虎牙 H2 协议夹具

`huya-real.json` 来自指挥方在宿主机于 2026-10-27 对 `kpl` (660002), `a16789` (528300), `117736` 的真实接收记录. 每房间同时运行 WSUserInfo / cmd1 与 WSRegisterGroupReq / cmd16 两条连接, 各 120 s. 原始文件为本地 `.runtime-cache/huya-h2-claude/raw-<房间>-<userInfo|group>.json`, 含真实身份资料, 不纳入版本控制. `2026-10-27T04:52Z` 起另做了约 90 s 的 kpl 网页对照: 网页 6 条聊天, cmd1 记录收到其中 5 条, 已收到消息的昵称与正文逐条一致. 未收到的 1 条处在此前误记为 malformed 的空帧附近, 丢失原因仍未确认, 不归因于空帧.

## 真实样本与范围

每个样本记录源文件和从 0 开始的记录索引, 保留真实的 TARS 字段编号, 类型, 结构层级和集合布局. 有效样本涵盖:

- cmd17 分组注册成功响应. 实际结构是 tag0 返回码 0, tag1 字符串列表, 列表仅回传 `chat:<主播uid>`, 不要求同时回传 live 组.
- cmd7 / URI1400 聊天, 包括真实 sender 及下游不使用的扩展结构.
- cmd22 / URI1400 聊天. 真实 MsgPushReq_V2 为 tag0 组名, tag1 列表; 列表元素为结构体, tag0 URI, tag1 消息 bytes, tag2 消息 ID.
- cmd7 / URI6501 礼物, 保留公共道具 ID, 数量与名称. 真实字段为 tag0 ID, tag2 数量, tag3/tag5 主播 UID/昵称, tag4/tag6 送礼者 UID/昵称, tag14 头像 URL, tag20 道具名, tag24 房间号. `05:18Z` a16789 网页礼物行及真实字段对照确认发送者应取 tag6, 而非 tag5 的主播昵称. 已观察到 `4 / 虎粮`, `20699 / 超粉虎粮`, `20865 / 热火`, `22003 / 3倍亲密12`. 这些抓取中没有 6502 或 6507, 两者仍由合成向量覆盖, 不假定 tag5 为发送者, 昵称保守显示匿名.
- cmd22 / URI8006 在线数, 消息体只有 tag0 整数. 本批完整记录中 kpl 为 138582-140224, 117736 为 222261-226129, a16789 为 645500-647469. 这是上游计数, 不声称等同唯一真人数量.
- cmd22 多元素混合批次, 以及含 double, 嵌套结构等未使用字段的 URI6111. 未支持的 URI 只计数后丢弃.
- 无法按 TARS 消息体解析的未知 URI3102, 其不透明 bytes 替换为空; 仍保留外层字段布局, 验证丢弃未知 URI 时不会误解码消息体.

本批 6 份记录共 578 项, 451 项有非空 hex, 127 项 hex 为空. 原标记 malformed 的 127 项与空 hex 记录一一对应. 指挥方随后在宿主机以 a16789 的 cmd16 连接观察 60 s, 87 条消息全部为 ArrayBuffer, 其中 20 条 byteLength 为 0, 无字符串或 Blob. 这确认空帧是服务端真实发送的零长度二进制消息, 并非抓取丢失载荷. 非空记录可全部进行独立的完整 TARS 读写往返, 未发现其外层或已支持消息体存在长度前缀, 压缩或字段类型错误. `emptyBinaryFrame` 保留一项真实空帧, kind 为 `captured-empty-binary`, 预期 `emptyFrame=true`, `malformed=false`; 客户端仅增加 emptyFrames 后忽略, 不延长 watchdog. 早期 `frames/kpl.json` 与 `frames/117736.json` 也各有一项空帧. 全部 8 文件合计 616 帧, 129 空帧, 非空帧解析失败为 0, 空帧不计解析失败.

本批 URI6501 全部由 cmd7 推送, 没有真实 cmd22 礼物样本. `derivedBatchChatGiftViewers` 明确标为 `derived-recombined`: 将三个真实来源已脱敏的聊天, 礼物与在线数消息体放入观测到的 cmd22 容器, 只用于验证批次路由, 不是额外抓到的真实 WebSocket 帧. 不以该向量宣称真实 cmd22 礼物已经独立验收.

## 脱敏与再编码

生成器是 [huya-danmaku-fixtures.mjs](../../../scripts/huya-danmaku-fixtures.mjs), 在本地执行 `node scripts/huya-danmaku-fixtures.mjs [原始文件目录]`. 它使用独立的最小 TARS AST reader / writer, 不调用生产 decoder 或 writer 来生成 expected. 首先检查每一项非空原始外层帧的读写往返与原 bytes 完全相同, 然后修改 AST 并重编码每一层 strings, bytes, lists, maps 和 structs 的长度, 不是直接替换 hex.

脱敏采用保留名单:

- 所有昵称, 聊天正文, 头像, UID, YYID, 主播 UID, payId, 消息 ID, 日期和其他身份或不明字段均替换. 主播 UID 固定为 `12345`, URI6501 的 tag5 主播昵称固定为 `presenter-placeholder`, tag6 送礼者昵称固定为 `viewer-placeholder`, 通过不同占位验证没有将主播误作发送者. 聊天昵称为 `viewer-placeholder`, 聊天正文为 `sanitized chat`, 头像为 `https://example.invalid/avatar.png`, 组名为 `live:12345` 或 `chat:12345`.
- 未使用的非空字符串一律为 `placeholder`, 原空字符串保持为空. 未使用的整数按其原 wire 类型替换为 0, 1, 42 或 12345, 浮点数替换为同宽度的 0. 整数字节宽度和 TARS type 保持不变.
- 未使用的不透明 byte 数组全部清空. 可识别的外层注册, 推送容器和已支持消息体逐层解析并再编码, 未知 URI 若可解析则保留已脱敏的完整字段形状.
- 仅保留 command, URI, 传输枚举, 注册成功码, 公共礼物 ID / 名称 / 数量及在线数. 原始字段没有整项删除; 未使用 byte 数组的内容除外. 编码后的长度随占位值变化, 不能与原始完整帧视为字节相同的 golden.

`huyaRealFrames.test.ts` 直接解码固定的脱敏真实向量并断言注册, 聊天, 礼物发送者昵称/名称/数量, 在线数, 未知 URI 计数及真实空帧分类. 原始昵称, UID, 头像或支付字段不从 decoder 导出.

## 合成与上游向量

`huya-synthetic.json` 保留人工构造的离线边界向量, 不冒充实际抓包. 注册 golden 按 TARS 格式独立写出. `biliupNotice` 按下列 Rust 测试的固定参数 (`nickname`, UID 42, sid 99, `hello danmaku`) 独立写出, 其余聊天帧包裹该 notice. 6502 / 6507 和注册失败等未在本批真实抓取出现的分支由合成向量覆盖.

协议参考: [biliup Rust Huya](https://github.com/biliup/biliup/blob/48a0d234794bb918e211076b357823438e8c109d/crates/danmaku/src/protocols/huya.rs), commit `48a0d234794bb918e211076b357823438e8c109d`, 查阅日期 2026-10-27. 采用其 MessageNotice 的 sender.tag2 / content.tag3, 60 s 心跳和固定匿名 heartbeat 字节. 分组注册及礼物 / 批量字段以本批真实数据及宿主探针为准. 未读取或复制 GPL-3 Simple Live 代码. biliup MIT 完整许可见 [既有许可文件](../../platforms/fixtures/huya-biliup-LICENSE.txt).
