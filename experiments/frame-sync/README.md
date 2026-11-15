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
