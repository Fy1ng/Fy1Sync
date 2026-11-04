import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { apiClient } from '../app/apiClient'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { Intake } from './Intake'
import { SourceLoaderProvider } from './sources'

const sessions: Session[] = []
beforeEach(() => {
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async () => ({ ok: true, value: { presets: [] } })) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})
afterEach(() => {
  cleanup()
  for (const session of sessions.splice(0)) session.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function submit() {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  render(<SessionProvider session={session}><SourceLoaderProvider>
    <Intake onClose={() => {}} onSchedule={() => {}} pendingFile={null} />
  </SourceLoaderProvider></SessionProvider>)
  fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
  const field = screen.getByLabelText('直播间链接')
  fireEvent.change(field, { target: { value: 'https://www.douyu.com/6657' } })
  fireEvent.submit(field.closest('form')!)
}

describe('source failure explanations', () => {
  it('shows a DNS failure returned at the API boundary with DNS-specific help', async () => {
    vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: false, code: 'dns-failed', message: '域名解析失败.' })
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('域名解析失败. 请检查网络与 DNS 设置后重新加载.')
    expect(screen.queryByText(/媒体地址未通过安全检查/)).not.toBeInTheDocument()
  })
  it.each([
    ['proxy' as const, 'proxy-unreachable', '代理不可达, 请检查系统代理.', '请确认代理软件已开启'],
    ['connect' as const, 'tls-certificate', '服务器证书校验失败.', '请检查系统时间和网络证书设置'],
    ['playback-not-ready' as const, 'media-format-invalid', '媒体格式无效或返回的内容不是可播放视频.', '请切换画质或使用其他可播放片源'],
  ])('shows %s/%s and its relevant next step', async (stage, reason, message, hint) => {
    vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: false, failure: {
      code: 'upstream-error', stage, reason, message,
    } } })
    submit()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(message)
    expect(alert).toHaveTextContent(hint)
    expect(screen.queryByText(/媒体地址未通过安全检查/)).not.toBeInTheDocument()
  })
})
