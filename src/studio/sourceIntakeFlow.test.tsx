import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../app/apiClient'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { primeMediaElement } from '../test/setup'
import { Intake } from './Intake'
import { SourceChip } from './SourceChip'
import { resetSavedRooms, type SavedRoom } from './savedRooms'
import { SourceLoaderProvider, useSourceLoader } from './sources'

let session: Session
const saved: SavedRoom = { id: 'saved', role: 'official', platform: 'huya', input: '12345', label: '测试收藏', savedAt: 0 }
beforeEach(() => {
  resetSavedRooms()
  vi.stubGlobal('streamSyncer', { invoke: vi.fn(async () => ({ ok: true, value: {} })) })
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = vi.fn(() => 'blob:local-file') })
  vi.spyOn(apiClient, 'feature').mockImplementation(async (method) => ({ ok: true, value: method === 'listSavedRooms' ? [saved] : {} }) as never)
  session = new Session({ createSampler: () => null })
})
afterEach(() => { cleanup(); resetSavedRooms(); session.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mount(children: React.ReactNode) {
  return render(<SessionProvider session={session}><SourceLoaderProvider>{children}</SourceLoaderProvider></SessionProvider>)
}

const direct = '/clip.mp4'
const file = new File(['video'], 'dropped.mp4', { type: 'video/mp4' })
const resolveFailure = { ok: false as const, code: 'test', message: '载入失败' }

function deferResolveFailure() {
  let fail!: () => void
  const resolve = vi.spyOn(apiClient, 'resolve').mockImplementationOnce(() => new Promise(done => {
    fail = () => done(resolveFailure)
  })).mockResolvedValue(resolveFailure)
  return { resolve, fail: () => fail() }
}

describe('source attachment and intake drafts', () => {
  it.each([false, true])('leaves the source panel open after a rejected attachment (local=%s) and retries in place', async (local) => {
    mount(<SourceChip role="official" />)
    fireEvent.click(screen.getByRole('button', { name: '画面：未载入' }))
    const field = screen.getByRole('textbox', { name: '画面链接' })
    const load = vi.spyOn(session, 'loadSource')
    if (local) fireEvent.change(screen.getByLabelText('本地文件'), { target: { files: [file] } })
    else {
      fireEvent.change(field, { target: { value: direct } })
      fireEvent.click(screen.getByRole('button', { name: '载入' }))
    }
    const video = session.engine.element('official')
    await waitFor(() => expect(session.engine.getState().official.attachMode).toBeTruthy())
    act(() => {
      Object.defineProperty(video, 'error', { configurable: true, value: { code: 4, message: 'not decodable' } })
      video.dispatchEvent(new Event('error'))
    })
    const retry = await screen.findByRole('button', { name: local ? '重试载入 dropped.mp4' : '载入' })
    expect(field).toHaveValue(local ? '' : direct)
    fireEvent.click(retry)
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    await act(async () => { primeMediaElement(video) })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '画面链接' })).toBeNull())
  })

  it.each(['ready', 'error'] as const)('accepts a slow attachment without a loader error, even if it later becomes %s', async (status) => {
    vi.useFakeTimers()
    try {
      let loader!: ReturnType<typeof useSourceLoader>
      function Controls() { loader = useSourceLoader(); return <SourceChip role="official" /> }
      mount(<Controls />)
      fireEvent.click(screen.getByRole('button', { name: '画面：未载入' }))
      fireEvent.change(screen.getByRole('textbox', { name: '画面链接' }), { target: { value: direct } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '载入' })) })
      expect(loader.state.official.busy).toBe(true)
      expect(session.engine.getState().official.status).toBe('loading')
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(session.engine.getState().official.status).toBe('loading')
      expect(loader.state.official).toMatchObject({ problem: null, busy: false })
      expect(screen.getByRole('button', { name: /^画面：/ })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('textbox', { name: '画面链接' })).toBeNull()

      const video = session.engine.element('official')
      await act(async () => {
        if (status === 'ready') primeMediaElement(video)
        else {
          Object.defineProperty(video, 'error', { configurable: true, value: { code: 4, message: 'not decodable' } })
          video.dispatchEvent(new Event('error'))
        }
      })
      expect(screen.getByRole('button', { name: /^画面：/ })).toHaveAttribute('data-status', status)
      expect(loader.state.official.problem).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a submitted bare room immediately and restores it and its platform on failure', async () => {
    const { resolve, fail } = deferResolveFailure()
    const close = vi.fn()
    mount(<Intake onClose={close} onSchedule={() => {}} pendingFile={null} />)
    fireEvent.click(screen.getByRole('radio', { name: /画面/ }))
    const field = screen.getByRole('textbox', { name: '直播间链接' })
    fireEvent.change(field, { target: { value: '12345' } })
    fireEvent.click(screen.getByRole('radio', { name: '哔哩哔哩' }))
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(field).toHaveValue('')
    expect(screen.queryByRole('radiogroup', { name: '选择房间号所属平台' })).toBeNull()
    await act(async () => { fail() })
    await screen.findByRole('alert')
    expect(field).toHaveValue('12345')
    expect(screen.getByRole('radio', { name: '哔哩哔哩' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    expect(resolve.mock.calls[1]?.slice(0, 3)).toEqual(['12345', 'bilibili', 'official'])
    expect(close).not.toHaveBeenCalled()
  })

  it.each(['edit', 'switch', 'switch-back'] as const)('does not restore an old submission after a draft %s', async (mode) => {
    const { fail } = deferResolveFailure()
    mount(<Intake onClose={vi.fn()} onSchedule={() => {}} pendingFile={null} />)
    fireEvent.click(screen.getByRole('radio', { name: /^画面/ }))
    const field = screen.getByRole('textbox', { name: '直播间链接' })
    fireEvent.change(field, { target: { value: '12345' } })
    fireEvent.click(screen.getByRole('radio', { name: '哔哩哔哩' }))
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    if (mode !== 'edit') {
      fireEvent.click(screen.getByRole('radio', { name: /^解说/ }))
      expect(field).toHaveValue('')
      if (mode === 'switch-back') fireEvent.click(screen.getByRole('radio', { name: /^画面/ }))
    } else fireEvent.change(field, { target: { value: '67890' } })
    await act(async () => { fail() })
    expect(field).toHaveValue(mode === 'edit' ? '67890' : '')
    expect(screen.queryByRole('radio', { name: '哔哩哔哩', checked: true })).toBeNull()
  })

  it('fills the source panel from a failed favorite so it can be retried there', async () => {
    const resolve = vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: false, code: 'test', message: '载入失败' })
    mount(<SourceChip role="official" />)
    fireEvent.click(screen.getByRole('button', { name: '画面：未载入' }))
    fireEvent.click(await screen.findByRole('button', { name: /测试收藏/ }))
    await screen.findByRole('alert')
    expect(screen.getByRole('textbox', { name: '画面链接' })).toHaveValue('12345')
    expect(screen.getByRole('radio', { name: '虎牙' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '载入' }))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    expect(resolve.mock.calls[1]?.slice(0, 3)).toEqual(['https://www.huya.com/12345', 'huya', 'official'])
  })

  it.each(['draft', 'loading'] as const)('does not close for a first frame with the other side %s', async mode => {
    const close = vi.fn()
    const { resolve, fail } = deferResolveFailure()
    mount(<Intake onClose={close} onSchedule={() => {}} pendingFile={null} />)
    const field = screen.getByRole('textbox', { name: '直播间链接' })
    fireEvent.click(screen.getByRole('radio', { name: /解说/ }))
    fireEvent.change(field, { target: { value: mode === 'draft' ? direct : '12345' } })
    if (mode === 'loading') {
      fireEvent.click(screen.getByRole('radio', { name: '斗鱼' }))
      fireEvent.click(screen.getByRole('button', { name: '添加' }))
      expect(field).toHaveValue('')
      expect(resolve).toHaveBeenCalled()
    }
    await act(async () => {
      await session.loadSource('official', { kind: 'progressive', url: direct, input: direct, label: '第一路', loop: false, viaProxy: false })
      const video = session.engine.element('official')
      primeMediaElement(video)
      Object.defineProperty(video, 'videoWidth', { value: 640 })
      video.dispatchEvent(new Event('loadeddata'))
    })
    expect(session.snapshot.media.official.firstFrame).toBe(true)
    expect(close).not.toHaveBeenCalled()
    if (mode === 'loading') await act(async () => { fail() })
    expect(field).toHaveValue(mode === 'draft' ? direct : '12345')
    expect(close).not.toHaveBeenCalled()
  })

  it('holds a dropped file until the viewer chooses a side', async () => {
    const load = vi.spyOn(session, 'loadSource')
    mount(<Intake onClose={vi.fn()} onSchedule={() => {}} pendingFile={file} />)
    expect(screen.getByText('已拖入 dropped.mp4。请先选择画面或解说。')).toBeInTheDocument()
    expect(load).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: /解说/ }))
    await waitFor(() => expect(load).toHaveBeenCalledExactlyOnceWith('commentary', expect.objectContaining({ input: file.name })))
    await act(async () => { primeMediaElement(session.engine.element('commentary')) })
    expect(screen.queryByText(/请先选择画面或解说/)).toBeNull()
  })
})
