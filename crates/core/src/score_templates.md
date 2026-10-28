# 比分模板来源

这些模板由本地原始录像的原生像素裁片生成, 数字标签来自人工查看的画面文本. 没有使用倒计时递减推断标签, 没有抓取网络素材, 没有包含录像或全幅图像.

- 官方源: `youtube-swMquqtyh-A-2160p60.mkv`, 3840x2160, SHA256 `93b4860d22531242c5b650239c6f15b87867f3e203718c90c5e55da63d95fd2b`.
- 解说源: `douyu-6657-原画1080P60.mkv`, 1920x1080, SHA256 `bb49cc14ba82c534d93da5242c5fcb669933839143082cbe3f7764c678f924bb`.
- 时间均为从录像起点计的 ffmpeg 抽帧请求秒数. 时间标签用于复现裁片, 不用于内容偏差真值.
- 先人工确认完整比分或时钟文本, 再按坐标裁切, 用 `max(R,G,B)>150` 提取比分, 用 `>170` 提取白色时钟. 用连通域分出字符, 人工核对生成的模板联系表. 每个字符紧裁后按最近邻归一化到 32x48, 使用现有 `pack_bitmap` 同等的逐行高位优先 bit/base64 格式.
- `pgl-score-upright` 与 `douyu-score-italic` 分别来自实际直立和倾斜比分. `pgl-clock-upright` 来自独立人工标签的同画面时钟, 只作为补充候选字形, 不作自动自学.

## 覆盖边界

原始五分钟录像的比分只实际出现官方 8:8/9:8/10:8 和解说 7:5/7:6/7:7/8:7. 因而直立比分模板覆盖 0/1/8/9, 倾斜比分模板覆盖 5/6/7/8. 其余 2/3/4 等候选来自人工标注的白色时钟字形. 总候选字库覆盖 0-9, 不能据此声称每个画面样式的每个比分数字都已获得真实比分验证. 未达到匹配质量或最佳与次佳差的数字返回空值, 不补猜缺失数字.

`score_test_fixtures.rs` 保存不同时间的独立留出比分原始二值裁片, 覆盖直立 0/1/8/9 与倾斜 5/6/7/8. 0-9 整数解析和两位数另有合成排版测试; 这些测试不冒充未见数字的真实比分准确率.

## 模板索引

坐标为原始视频像素 `(x,y,width,height)`. 索引顺序对应 `score_templates.rs`.

| 索引 | 数字 | 样式 | 人工标签来源 | 裁片 |
| --- | --- | --- | --- | --- |
| 0 | 1 | `pgl-clock-upright` | official@30 manually labeled clock 1:49 | `(1859, 104, 20, 53)` |
| 1 | 4 | `pgl-clock-upright` | official@30 manually labeled clock 1:49 | `(1905, 104, 30, 53)` |
| 2 | 9 | `pgl-clock-upright` | official@30 manually labeled clock 1:49 | `(1936, 104, 28, 53)` |
| 3 | 8 | `pgl-score-upright` | official@60 score 0 | `(1732, 96, 49, 99)` |
| 4 | 8 | `pgl-score-upright` | official@60 score 1 | `(2045, 96, 47, 99)` |
| 5 | 1 | `pgl-clock-upright` | official@60 manually labeled clock 1:19 | `(1860, 104, 19, 53)` |
| 6 | 9 | `pgl-clock-upright` | official@60 manually labeled clock 1:19 | `(1937, 104, 27, 53)` |
| 7 | 0 | `pgl-clock-upright` | official@80 manually labeled clock 0:59 | `(1857, 104, 28, 53)` |
| 8 | 5 | `pgl-clock-upright` | official@80 manually labeled clock 0:59 | `(1906, 104, 28, 53)` |
| 9 | 0 | `pgl-clock-upright` | official@90 manually labeled clock 0:07 | `(1857, 104, 28, 53)` |
| 10 | 7 | `pgl-clock-upright` | official@90 manually labeled clock 0:07 | `(1935, 104, 29, 53)` |
| 11 | 9 | `pgl-score-upright` | official@180 score 0 | `(1732, 96, 49, 99)` |
| 12 | 8 | `pgl-score-upright` | official@180 score 1 | `(2045, 96, 48, 99)` |
| 13 | 3 | `pgl-clock-upright` | official@180 manually labeled clock 1:35 | `(1906, 104, 28, 53)` |
| 14 | 5 | `pgl-clock-upright` | official@180 manually labeled clock 1:35 | `(1936, 104, 28, 53)` |
| 15 | 1 | `pgl-score-upright` | official@280 score 0 | `(1709, 96, 34, 99)` |
| 16 | 0 | `pgl-score-upright` | official@280 score 0 | `(1760, 96, 47, 99)` |
| 17 | 8 | `pgl-score-upright` | official@280 score 1 | `(2045, 96, 48, 99)` |
| 18 | 3 | `pgl-clock-upright` | official@280 manually labeled clock 1:35 | `(1906, 104, 28, 53)` |
| 19 | 6 | `pgl-clock-upright` | official@299 manually labeled clock 1:16 | `(1937, 104, 27, 53)` |
| 20 | 7 | `douyu-score-italic` | commentary@0 score 0 | `(866, 49, 25, 49)` |
| 21 | 5 | `douyu-score-italic` | commentary@0 score 1 | `(1023, 48, 23, 50)` |
| 22 | 2 | `pgl-clock-upright` | commentary@0 manually labeled clock 1:21 | `(954, 52, 13, 27)` |
| 23 | 7 | `douyu-score-italic` | commentary@80 score 0 | `(866, 49, 25, 49)` |
| 24 | 6 | `douyu-score-italic` | commentary@80 score 1 | `(1022, 48, 24, 50)` |
| 25 | 7 | `douyu-score-italic` | commentary@200 score 0 | `(866, 49, 25, 49)` |
| 26 | 7 | `douyu-score-italic` | commentary@200 score 1 | `(1022, 48, 25, 50)` |
| 27 | 8 | `douyu-score-italic` | commentary@280 score 0 | `(866, 49, 24, 49)` |
| 28 | 7 | `douyu-score-italic` | commentary@280 score 1 | `(1022, 48, 25, 50)` |
