import type { BufferState } from '../../electron/bufferManager'

const reasons: Record<string, string> = {
  'tool-missing': '找不到可用的 ffmpeg，请重新安装应用',
  'tool-invalid-path': 'ffmpeg 路径无效',
  'tool-not-executable': 'ffmpeg 无法执行',
  'buffer-write-failed': '无法写入本地缓冲，请检查磁盘和目录权限',
  'source-resolve-failed': '无法重新获取直播地址，请检查登录状态后重新载入',
  'invalid-buffer-input': '播放地址无效，请重新载入',
  'ffmpeg-launch-failed': '无法启动取流工具',
  'upstream-ended': '直播源中断且重试次数已用尽',
  'upstream-stalled': '直播源持续停滞且重试次数已用尽',
}

type Stage = NonNullable<BufferState['failure']>['stage']

/** Which step broke, and what the viewer can do about it. */
const STAGES: Record<Stage, string> = {
  resolve: '无法获取直播地址，请确认正在直播后重新载入',
  proxy: '无法连接取流代理，请检查网络设置',
  connect: '无法连接直播服务器，请检查网络设置',
  http: '直播服务器拒绝了请求',
  stall: '已连上但没有收到新的直播数据',
  'playback-not-ready': '收到了数据但还没有可播放的画面',
}

function stageText(failure: NonNullable<BufferState['failure']>): string {
  const base = STAGES[failure.stage]
  return failure.stage === 'http' && failure.status ? `${base}（HTTP ${failure.status}）` : base
}

export function bufferStatusText(state: BufferState): string {
  const seconds = `${state.seconds.toFixed(1)} 秒`
  switch (state.state) {
    case 'starting': return '正在启动本地缓冲'
    case 'buffering': return `正在缓冲，已保存 ${seconds}`
    case 'ready': return `本地缓冲可用 ${seconds}`
    case 'stalled': return `直播数据暂时停滞，已保存 ${seconds}`
    case 'reconnecting': return `正在重新连接，第 ${state.attempt ?? 1} 次重试${state.failure ? `：${stageText(state.failure)}` : ''}`
    case 'failed': return `本地缓冲失败：${state.failure ? stageText(state.failure) : reasons[state.reason ?? ''] ?? '请重新载入片源'}`
    case 'stopped': return '本地缓冲已停止'
  }
}
