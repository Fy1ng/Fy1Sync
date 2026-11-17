# 帧指纹同步隔离实验

本目录只验证算法和本地媒体工具的可行性, 不导入生产模块, 不修改播放器, 不访问网络或用户账号目录. 详细本地评估保存在 `docs/frame-fingerprint-assessment.md`, 遵循仓库对 `docs/` 的忽略规则.

## 运行

要求 Node.js >= 22.12.0. 算法测试无需 npm 依赖:

```powershell
node --test experiments/frame-sync/fingerprint.test.mjs
```

媒体实验需要支持 libx264 和 lavfi 的开发版 FFmpeg 生成合成视频. 实际解码和 PTS 提取可以指定本项目随包的裁剪版工具:

```powershell
$env:FRAME_SYNC_GENERATOR = 'ffmpeg'
$env:FRAME_SYNC_FFMPEG = 'C:\path\to\bundled\ffmpeg.exe'
$env:FRAME_SYNC_FFPROBE = 'C:\path\to\bundled\ffprobe.exe'
node experiments/frame-sync/run.mjs
```

环境变量只影响当前 PowerShell 会话. 未指定时使用 PATH 中的工具. 合成媒体和运行报告均保存在 `.runtime-cache/frame-sync/`, 不写入真实用户资料. 报告包括工具版本, 每个场景的断言结果, 帧对应误差, 计算时间和限制.

## 文件

- `fingerprint.mjs`: 分块 DCT pHash, 局部灰度细节, 有界时间假设搜索, 单调动态规划, 运动一致性检查, 时间映射及有界指纹窗口.
- `fingerprint.test.mjs`: 静止/循环/无关画面, 低幅变化, 广告遮挡, 丢帧/重复帧, 漂移拟合, 共享观察时钟和换代失效测试.
- `media.mjs`: 仅生成并读取实验目录内的合成媒体, 使用 ffprobe 逐帧 PTS 和 FFmpeg passthrough 原始灰度输出.
- `run.mjs`: 1080p60/1440p30/1080p25, 不同压缩, 遮挡, 画中画裁剪, 无共同片段, 方向交换和滑动窗口检查.

## 本次结果

基于 `745c53b`, 16 项算法测试和 11 项媒体场景检查通过. 合成样本的正确匹配场景 P95 帧对应误差不超过 16.667 ms; 这不代表实际送显或音视频同步精度. 110 次局部相邻帧选择中, pHash 单独选对 102 次, 细节比较选对 110 次, 不保证其他画面也能唯一识别.

结论是适合作为现有倒计时测量的补充. 必须把媒体 PTS 映射转换为当前播放残差, 检查运动一致性和重复片段歧义, 并保留原有应用后验证. 推荐正式接入时复用现有 video 和 Worker/WASM 路径, 是否采用仍需单独确认. 本实验没有实现自动画面配准, 真实直播取样或音视频输出控制.

## 本地赛事录像测试

`real-video.mjs` 接收两段明确提供的本地视频. 原文件只读, 通过 streamcopy 在 `.runtime-cache/frame-sync-real/` 生成最多 900 帧的短片, 保留原 PTS, 不转换编码后再匹配:

```powershell
node experiments/frame-sync/real-video.mjs 'C:\path\1080p.mp4' 'C:\path\1440p.mkv'
```

同样通过 `FRAME_SYNC_FFMPEG` / `FRAME_SYNC_FFPROBE` 指定工具. 默认抽样起点为 0, 30, 120, 300, 600, 900, 1200, 1500, 1800, 2100, 2700, 3075 s, 每窗 6 s. 使用其他时长的文件时, 通过 `FRAME_SYNC_STARTS='0,30,120'` 指定不越过文件结尾的窗口. 默认报告为 `real-report.json`, 指定窗口时保存独立报告, 保留默认基线.

测试保持匹配器原参数. 对运动一致性拒绝的窗口, 另外暴露被拒假设, 使用 320x180 全窗逐帧像素搜索和多个差分跨度诊断; 该诊断不改变原接受/拒绝结果. 第 1500 s 窗口另测降帧、丢帧/重复画面及无重叠内容. 原录像没有精确人工帧标签, 因此交叉检查一致率不代表绝对帧精度.

用户提供的 Atlanta 2026 Anubis 两段录像实测: 默认 12 窗中 10 窗接受、2 窗拒绝. 接受窗口中位映射为 `A_media = B_media - 0.971 s`, 即相同文件播放时间下 1080p 领先约 0.971 s. 第 120 s 近静态视角与第 1800 s 半场等待画面触发保守拒绝. 1800 s 的高分辨率抽查出现约一帧的相邻帧选择差异, 不能承诺所有相邻帧唯一识别. 详细本地记录见 `docs/frame-fingerprint-real-video-test.md`.
