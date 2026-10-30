import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { apiClient } from '../app/apiClient'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { Intake } from './Intake'
import { SOURCE_HINT, SourceLoaderProvider } from './sources'

const sessions: Session[] = []

beforeEach(() => {
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async () => ({ ok: true, value: { presets: [] } })) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  render(<SessionProvider session={session}><SourceLoaderProvider>
    <Intake onClose={() => {}} onSchedule={() => {}} pendingFile={null} />
  </SourceLoaderProvider></SessionProvider>)
  return session
}

describe('either side takes any source', () => {
  it('offers the same sources for 画面 and 解说', () => {
    mount()
    for (const side of [/画面/, /解说/]) {
      fireEvent.click(screen.getByRole('radio', { name: side }))
      expect(screen.getByLabelText('直播间链接')).toHaveAttribute('placeholder', SOURCE_HINT)
    }
  })

  it('loads a Douyu room as 画面 and a YouTube link as 解说', async () => {
    const session = mount()
    vi.spyOn(session, 'loadSource').mockResolvedValue(undefined)
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: false, code: 'test', message: '测试结束' })

    fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
    const field = screen.getByLabelText('直播间链接')
    fireEvent.change(field, { target: { value: '6657' } })
    fireEvent.click(screen.getByRole('radio', { name: '斗鱼' }))
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('6657', 'douyu', 'official', undefined, true))

    fireEvent.click(screen.getByRole('radio', { name: /解说/ }))
    fireEvent.change(field, { target: { value: 'https://www.youtube.com/watch?v=swMquqtyh-A' } })
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(expect.stringContaining('swMquqtyh-A'), 'youtube', 'commentary', undefined, true))
  })
})
