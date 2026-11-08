import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { apiClient } from '../app/apiClient'
import { SessionProvider } from '../app/SessionContext'
import { Session } from '../app/session'
import { Intake } from './Intake'
import { SourceLoaderProvider } from './sources'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('imports without replacing playback and loads the selected channel on the chosen side', async () => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', '') })
  HTMLDialogElement.prototype.close = vi.fn()
  const session = new Session()
  const load = vi.spyOn(session, 'loadSource').mockResolvedValue(undefined)
  const input = 'playlist:12345678-1234-1234-1234-123456789012'
  vi.spyOn(apiClient, 'importPlaylist').mockResolvedValue({ ok: true, value: { kind: 'channels', entries: [{ name: '测试频道', group: '体育', input }] } })
  const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: true, stream: {
    platform: 'direct', kind: 'hls', label: '测试频道', channel: input, url: 'app://app/buffer/test/index.m3u8', requiresProxy: false,
  } } })
  render(<SessionProvider session={session}><SourceLoaderProvider><Intake onClose={() => {}} onSchedule={() => {}} pendingFile={null} /></SourceLoaderProvider></SessionProvider>)
  fireEvent.click(screen.getByRole('radio', { name: /解说/ }))
  const field = screen.getByLabelText('直播间链接')
  fireEvent.change(field, { target: { value: 'https://lists.example/channels.m3u' } })
  fireEvent.submit(field.closest('form')!)
  const channel = await screen.findByRole('button', { name: /测试频道/ })
  expect(load).not.toHaveBeenCalled()
  expect(resolve).not.toHaveBeenCalled()
  fireEvent.click(channel)
  await waitFor(() => expect(resolve).toHaveBeenCalledWith(input, 'direct', 'commentary', undefined, true))
  await waitFor(() => expect(load).toHaveBeenCalledWith('commentary', expect.objectContaining({ label: '测试频道' })))
  session.dispose()
})
