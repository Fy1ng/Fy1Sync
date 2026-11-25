import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    <Intake onClose={() => {}} onSchedule={() => {}} />
  </SourceLoaderProvider></SessionProvider>)
  fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
  const field = screen.getByLabelText('直播间链接')
  fireEvent.change(field, { target: { value: 'https://www.douyu.com/6657' } })
  fireEvent.submit(field.closest('form')!)
}

describe('source failure explanations', () => {
  it('shows a DNS failure returned at the API boundary with DNS-specific help', async () => {
    vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: false, code: 'dns-failed', message: '域名解析失败' })
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('域名解析失败，请检查网络与 DNS 设置后重新载入')
    expect(screen.queryByText(/媒体地址未通过安全检查/)).not.toBeInTheDocument()
  })
  it.each([
    ['proxy' as const, 'proxy-unreachable', '无法连接取流代理', '请在「设置 > 通用 > 网络」检查代理设置'],
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

  it('offers in-place yt-dlp update and network settings on YouTube extraction failure and retries after updating', async () => {
    const onOpenSettings = vi.fn()
    const session = new Session({ createSampler: () => null })
    sessions.push(session)
    vi.spyOn(session, 'loadSource').mockResolvedValue(undefined)
    const resolve = vi.spyOn(apiClient, 'resolve')
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ok: false,
          failure: {
            code: 'upstream-error',
            stage: 'resolve',
            reason: 'upstream-error',
            message: '暂时无法获取 YouTube 直播',
            hint: '请确认代理可用，也可更新 yt-dlp 或登录 YouTube 后重试',
            detail: { code: 'extractor-failed' },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ok: true,
          stream: {
            platform: 'youtube',
            kind: 'hls',
            url: 'app://app/media/yt',
            label: 'YouTube 直播',
            channel: 'abcdefghijk',
            requiresProxy: false,
          },
        },
      })
    const updateYtdlp = vi.spyOn(apiClient, 'updateYtdlp').mockResolvedValue({
      ok: true,
      value: {
        tools: [],
        provider: { available: false, source: 'none', version: '' },
        externalYtdlp: false,
        fixturesAvailable: false,
        bundledAvailable: true,
        update: { phase: 'ready', downloadedBytes: 100, totalBytes: 100, message: '已更新' },
      },
    })

    render(
      <SessionProvider session={session}>
        <SourceLoaderProvider onOpenSettings={onOpenSettings}>
          <Intake onClose={() => {}} onSchedule={() => {}} />
        </SourceLoaderProvider>
      </SessionProvider>,
    )
    expect(screen.getByText('支持一键选择直播间')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: 'https://www.youtube.com/watch?v=abcdefghijk' } })
    fireEvent.submit(field.closest('form')!)

    const updateBtn = await screen.findByRole('button', { name: '更新 yt-dlp 并重试' })
    const netBtn = screen.getByRole('button', { name: '网络设置' })
    const rawBtn = screen.getByRole('button', { name: '查看原始错误' })
    expect(updateBtn.parentElement).toBe(netBtn.parentElement)
    expect(updateBtn.parentElement).toBe(rawBtn.parentElement)

    fireEvent.click(netBtn)
    expect(onOpenSettings).toHaveBeenCalledWith({ section: 'general', general: 'network' })

    fireEvent.click(updateBtn)
    await waitFor(() => expect(updateYtdlp).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    expect(resolve.mock.calls[1]![0]).toBe('https://www.youtube.com/watch?v=abcdefghijk')
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('opens decoding settings from codec/format errors', async () => {
    const onOpenSettings = vi.fn()
    const session = new Session({ createSampler: () => null })
    sessions.push(session)
    vi.spyOn(apiClient, 'resolve').mockResolvedValue({
      ok: true,
      value: {
        ok: false,
        failure: {
          code: 'upstream-error',
          stage: 'playback-not-ready',
          reason: 'media-codec-unsupported',
          message: '当前媒体编码不受支持，请切换画质或片源',
        },
      },
    })
    render(
      <SessionProvider session={session}>
        <SourceLoaderProvider onOpenSettings={onOpenSettings}>
          <Intake onClose={() => {}} onSchedule={() => {}} />
        </SourceLoaderProvider>
      </SessionProvider>,
    )
    fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: 'https://example.com/live.m3u8' } })
    fireEvent.submit(field.closest('form')!)

    const decodeBtn = await screen.findByRole('button', { name: '解码设置' })
    fireEvent.click(decodeBtn)
    expect(onOpenSettings).toHaveBeenCalledWith({ section: 'general', general: 'decoding' })
  })
})
