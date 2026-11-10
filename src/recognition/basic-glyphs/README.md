# 基础数字先验

`../basicGlyphPriors.json` 是通用字体绘制出的 32x48 单色位图, 不包含赛事录像截图或用户训练样本. 应用不加载这些字体文件, 不访问网络, 只读取位图.

字体来自 [DINish 项目](https://github.com/playbeing/dinish), 使用 SIL Open Font License 1.1. 完整许可见 [DINish-OFL.txt](./DINish-OFL.txt). 数字位图及其来源资料保留该许可声明.

固定源版本为 `a5f3b2a3b932336225815bf9005e3b72cc3de71c`.

| 字体 | 固定源文件 | SHA-256 |
| --- | --- | --- |
| DINish Bold | [DINish-Bold.ttf](https://github.com/playbeing/dinish/blob/a5f3b2a3b932336225815bf9005e3b72cc3de71c/fonts/ttf/DINish/DINish-Bold.ttf) | `7bf267d086d6dfebeca41c3bfbac91a50c29a7d4aded91da8d2ff5905b06f3e8` |
| DINish Condensed Bold | [DINishCondensed-Bold.ttf](https://github.com/playbeing/dinish/blob/a5f3b2a3b932336225815bf9005e3b72cc3de71c/fonts/ttf/DINishCondensed/DINishCondensed-Bold.ttf) | `6f82c649e1c7b6ab5ba20421209b1ba77fcd24a3545c2168e6f8cba78da70f1b` |

绘制使用 Electron 44 的 Chromium Canvas, 画布为 192x160, 黑底白字, alphabetic 基线, `fillText(char, 32, 112)`. 字符为 `0123456789:`. 字体通过 FontFace 加载, 每个文件作为独立字体族, CSS weight 为 400. 绘制参数对所有字符一致:

- DINish Condensed Bold: 字号 48, 72, 水平缩放 1, 1.1, 白色轮廓宽度 0, 1.2px 的笛卡尔积. 另外绘制字号 24, 水平缩放 1, 1.1, 不添加轮廓. 小字号加粗会使0与8的内部结构过于相似, 因而排除.
- DINish Bold: 字号 48, 72, 水平缩放 0.8, 白色轮廓宽度 1.5, 2.5px 的笛卡尔积.
- 非零轮廓使用 `strokeText` 后再 `fillText`, `lineJoin = 'round'`. 轮廓变体覆盖通用的光学字重差异.
- 取红色通道, 以 128 二值化, 调用项目的 `normalizeGlyph`, 再使用 `packBitmap` 编码, 按字符去重. 每个数字 14 个模板, 冒号 12 个模板.

运行时另有本机系统字体先验, 可覆盖不同的数字结构. 总数量不超过 Rust 的每字 96 个模板限制, 匹配门槛保持 0.82 IoU 和 0.035 不同字符分差.
