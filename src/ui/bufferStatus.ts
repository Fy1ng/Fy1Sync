import type { BufferState } from '../../electron/bufferManager'

const reasons: Record<string, string> = {
  'tool-missing': '未找到 ffmpeg, 请配置工具路径',
  'tool-invalid-path': 'ffmpeg 路径无效',
  'tool-not-executable': 'ffmpeg 无法执行',
  'buffer-write-failed': '无法写入本地缓冲, 请检查磁盘和目录权限',
  'source-resolve-failed': '无法重新获取直播地址, 请检查登录状态后重新加载',
  'invalid-buffer-input': '播放地址无效, 请重新加载',
  'ffmpeg-launch-failed': '无法启动转封装工具',
  'upstream-ended': '直播源中断且重试次数已用尽',
  'upstream-stalled': '直播源持续停滞且重试次数已用尽',
}

export function bufferStatusText(state: BufferState): string {
  const seconds = `${state.seconds.toFixed(1)}s`
  switch (state.state) {
    case 'starting': return '正在启动本地缓冲'
    case 'buffering': return `正在缓冲, 已保存 ${seconds}`
    case 'ready': return `本地缓冲可用 ${seconds}`
    case 'stalled': return `直播数据暂时停滞, 已保存 ${seconds}`
    case 'reconnecting': return `正在重新取流, 第 ${state.attempt ?? 1} 次重试`
    case 'failed': return `本地缓冲失败: ${reasons[state.reason ?? ''] ?? '请重新加载片源'}`
    case 'stopped': return '本地缓冲已停止'
  }
}
