import { describe, expect, it } from 'vitest'
import { bufferStatusText } from './bufferStatus'

describe('bufferStatusText', () => {
  it('names the broken step instead of a generic failure', () => {
    expect(bufferStatusText({ role: 'official', state: 'failed', seconds: 0, failure: { stage: 'proxy', code: 'proxy-unreachable', message: 'x' } }))
      .toBe('本地缓冲失败: 连不上代理, 请确认代理软件已开启, 可在 设置 › 网络 查看系统代理')
    expect(bufferStatusText({ role: 'official', state: 'failed', seconds: 0, failure: { stage: 'http', code: 'http-403', message: 'x', status: 403 } }))
      .toBe('本地缓冲失败: 直播服务器拒绝了请求 (HTTP 403)')
  })

  it('says why it is retrying while it retries', () => {
    expect(bufferStatusText({ role: 'commentary', state: 'reconnecting', seconds: 3, attempt: 2, failure: { stage: 'stall', code: 'upstream-stalled', message: 'x' } }))
      .toBe('正在重新取流, 第 2 次重试: 已连上但没有收到新的直播数据')
    expect(bufferStatusText({ role: 'commentary', state: 'reconnecting', seconds: 3, attempt: 1 })).toBe('正在重新取流, 第 1 次重试')
  })

  it('keeps the old reason text when main sends no stage', () => {
    expect(bufferStatusText({ role: 'official', state: 'failed', seconds: 0, reason: 'tool-missing' })).toBe('本地缓冲失败: 未找到 ffmpeg, 请配置工具路径')
  })
})
