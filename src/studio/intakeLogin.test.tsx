import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { apiClient } from '../app/apiClient'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { Intake } from './Intake'
import { SourceLoaderProvider } from './sources'

const sessions: Session[] = []
let signedIn = false

function mount(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  vi.spyOn(session, 'loadSource').mockResolvedValue(undefined)
  render(<SessionProvider session={session}><SourceLoaderProvider>
    <Intake onClose={() => {}} onSchedule={() => {}} pendingFile={null} />
  </SourceLoaderProvider></SessionProvider>)
  return session
}

const stepDown = { ok: true as const, value: { ok: true as const, stream: {
  platform: 'douyu' as const, kind: 'hls' as const, url: 'app://app/media/douyu', label: '斗鱼 6979222',
  channel: '6979222', sourceRoom: '6979222', requiresProxy: false, quality: '4', qualities: [{ id: '0', label: '原画' }, { id: '4', label: '蓝光' }],
} } }

beforeEach(() => {
  signedIn = false
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => {
      if (method === 'loginStatus') return { ok: true, value: { douyu: { loggedIn: signedIn }, youtube: { loggedIn: false } } }
      if (method === 'getToolsStatus') return { ok: true, value: { tools: [], fixturesAvailable: false } }
      return { ok: true, value: { presets: [] } }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function addDouyuRoom(): Promise<void> {
  fireEvent.click(screen.getByRole('radio', { name: /解说/ }))
  const field = screen.getByLabelText('直播间链接')
  fireEvent.change(field, { target: { value: '6979222' } })
  fireEvent.click(screen.getByRole('radio', { name: '斗鱼' }))
  fireEvent.submit(field.closest('form')!)
}

describe('the login offer on the intake screen', () => {
  it('offers a Douyu login when the room came back below 原画, and reloads after it', async () => {
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue(stepDown)
    const login = vi.spyOn(apiClient, 'login').mockImplementation(async () => { signedIn = true; return { ok: true, value: { cookieCount: 4, authKeysPresent: ['acf_uid'] } } })
    mount()
    await addDouyuRoom()
    const offer = await screen.findByText('登录斗鱼可看最高画质')
    fireEvent.click(offer.parentElement!.querySelector('button')!)
    await waitFor(() => expect(login).toHaveBeenCalledWith('douyu'))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    expect(resolve.mock.calls[1]![0]).toBe('6979222')
    expect(resolve.mock.calls[1]![2]).toBe('commentary')
  })

  it('says nothing to someone already signed in, or when 原画 came back', async () => {
    signedIn = true
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue(stepDown)
    mount()
    await addDouyuRoom()
    await waitFor(() => expect(resolve).toHaveBeenCalled())
    await new Promise((done) => setTimeout(done, 20))
    expect(screen.queryByText(/可看最高画质/)).toBeNull()

    cleanup()
    signedIn = false
    resolve.mockResolvedValue({ ok: true, value: { ok: true, stream: { ...stepDown.value.stream, quality: '0' } } })
    mount()
    await addDouyuRoom()
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    await new Promise((done) => setTimeout(done, 20))
    expect(screen.queryByText(/可看最高画质/)).toBeNull()
  })

  it('offers a YouTube login to retry when YouTube refuses without one', async () => {
    vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: false, failure: { code: 'restricted', message: 'YouTube 要求登录, 或此直播受到访问限制.' } } })
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: 'https://www.youtube.com/watch?v=abcdefghijk' } })
    fireEvent.submit(field.closest('form')!)
    expect(await screen.findByText('登录 YouTube 后重试')).toBeInTheDocument()
  })
})
