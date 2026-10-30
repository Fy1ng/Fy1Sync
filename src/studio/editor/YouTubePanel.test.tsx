import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_CLIP_SECONDS, YouTubePanel, clock, youtubeVideoId, type YouTubeBrowseState, type YouTubeClipJob, type YouTubeSource } from './YouTubePanel'

afterEach(cleanup)

function fakeSource() {
  let push: (state: YouTubeBrowseState | null) => void = () => {}
  let current: YouTubeBrowseState | null = null
  let pushJobs: (jobs: YouTubeClipJob[]) => void = () => {}
  const source: YouTubeSource = {
    open: vi.fn(async () => ({ ok: true as const })),
    close: vi.fn(async () => {}),
    place: vi.fn(async () => {}),
    subscribe: (listener) => { push = listener; return () => {} },
    now: vi.fn(async () => current),
    still: vi.fn(async () => ({ ok: true as const, still: {
      frame: { pixels: new Uint8ClampedArray(4), width: 3840, height: 2160, mediaTime: 0, wallTime: 0 },
      native: true, videoId: 'swMquqtyh-A', approxTime: 754,
    } })),
    startClip: vi.fn(async () => ({ ok: true as const, jobId: 'j1' })),
    cancelClip: vi.fn(async () => {}),
    subscribeClips: (listener) => { pushJobs = listener; return () => {} },
  }
  const state = (over: Partial<YouTubeBrowseState> = {}): YouTubeBrowseState => ({
    videoId: 'swMquqtyh-A', title: 'Team Spirit vs. Natus Vincere', duration: 3600, currentTime: 0, playing: false,
    videoWidth: 3840, videoHeight: 2160, advert: false, playerOnly: true, error: null, ...over,
  })
  return { source, push: (s: YouTubeBrowseState | null) => act(() => { current = s; push(s) }), pushJobs: (j: YouTubeClipJob[]) => act(() => pushJobs(j)), state }
}

async function opened(fake: ReturnType<typeof fakeSource>, handlers = { onStill: vi.fn(), onClipReady: vi.fn() }) {
  render(<YouTubePanel source={fake.source} {...handlers} />)
  fireEvent.change(screen.getByLabelText('YouTube 录像链接'), { target: { value: 'https://www.youtube.com/watch?v=swMquqtyh-A' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开' })) })
  return handlers
}

describe('youtubeVideoId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=swMquqtyh-A', 'swMquqtyh-A'],
    ['youtube.com/watch?v=swMquqtyh-A&t=12', 'swMquqtyh-A'],
    ['https://youtu.be/swMquqtyh-A', 'swMquqtyh-A'],
    ['https://www.youtube.com/live/swMquqtyh-A?si=x', 'swMquqtyh-A'],
    ['swMquqtyh-A', 'swMquqtyh-A'],
  ])('reads %s', (text, id) => expect(youtubeVideoId(text)).toBe(id))

  it.each(['https://evil.example/watch?v=swMquqtyh-A', 'https://www.youtube.com/', 'not a link'])('rejects %s', (text) => {
    expect(youtubeVideoId(text)).toBeNull()
  })
})

describe('the YouTube panel', () => {
  it('opens the normalised watch link, not what was typed', async () => {
    const fake = fakeSource()
    await opened(fake)
    expect(fake.source.open).toHaveBeenCalledWith('https://www.youtube.com/watch?v=swMquqtyh-A')
  })

  it('says when the page is not decoding 4K', async () => {
    const fake = fakeSource()
    await opened(fake)
    fake.push(fake.state({ videoWidth: 1920, videoHeight: 1080 }))
    expect(screen.getByText(/不是 4K/)).toBeInTheDocument()
    expect(screen.getByText('1920×1080')).toBeInTheDocument()
    fake.push(fake.state())
    expect(screen.queryByText(/不是 4K/)).toBeNull()
  })

  it('hands a still to the editor', async () => {
    const fake = fakeSource()
    const handlers = await opened(fake)
    fake.push(fake.state())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '截当前画面' })) })
    expect(handlers.onStill).toHaveBeenCalledWith(expect.objectContaining({ native: true, videoId: 'swMquqtyh-A' }))
  })

  it('downloads the marked stretch and refuses one over the limit', async () => {
    const fake = fakeSource()
    await opened(fake)
    fake.push(fake.state({ currentTime: 750 }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /设为入点/ })) })
    fake.push(fake.state({ currentTime: 930 }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /设为出点/ })) })
    const download = screen.getByRole('button', { name: /下载这一段/ })
    expect(download).toHaveTextContent('3:00')
    await act(async () => { fireEvent.click(download) })
    expect(fake.source.startClip).toHaveBeenCalledWith('https://www.youtube.com/watch?v=swMquqtyh-A', 750, 930)

    fake.push(fake.state({ currentTime: 750 + MAX_CLIP_SECONDS + 1 }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /设为出点/ })) })
    expect(screen.getByRole('button', { name: /下载这一段/ })).toBeDisabled()
    expect(screen.getByText('一次最多下载 5 分钟')).toBeInTheDocument()
  })

  it('keeps the buttons off until the player alone is showing', async () => {
    const fake = fakeSource()
    await opened(fake)
    fake.push(fake.state({ playerOnly: false }))
    expect(screen.getByText('正在载入…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '截当前画面' })).toBeDisabled()
    fake.push(fake.state({ playerOnly: false, error: 'player-only-failed' }))
    expect(screen.getByText('无法只显示播放器，请重新打开录像')).toBeInTheDocument()
    fake.push(fake.state())
    expect(screen.queryByText('正在载入…')).toBeNull()
    expect(screen.getByRole('button', { name: '截当前画面' })).toBeEnabled()
  })

  it('tells main where the player goes, and hides it when the editor goes away', async () => {
    const fake = fakeSource()
    await opened(fake)
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    expect(fake.source.place).toHaveBeenCalledWith(expect.objectContaining({ width: expect.any(Number) }), expect.any(Boolean))
    cleanup()
    expect(fake.source.place).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 }, false)
  })

  it('hides the player only while a menu of ours overlaps it', async () => {
    const fake = fakeSource()
    await opened(fake)
    const slot = document.querySelector('.yt-player') as HTMLElement
    slot.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 640, height: 360 })
    const menu = document.createElement('dialog')
    menu.setAttribute('open', '')
    document.body.append(menu)
    const frame = () => act(async () => {
      document.dispatchEvent(new Event('toggle'))
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    // A menu in the header, above the player.
    menu.getBoundingClientRect = () => DOMRect.fromRect({ x: 500, y: 10, width: 180, height: 80 })
    await frame()
    expect(fake.source.place).toHaveBeenLastCalledWith({ x: 0, y: 100, width: 640, height: 360 }, true)
    // The same menu grown down over the player.
    menu.getBoundingClientRect = () => DOMRect.fromRect({ x: 500, y: 10, width: 180, height: 200 })
    await frame()
    expect(fake.source.place).toHaveBeenLastCalledWith({ x: 0, y: 100, width: 640, height: 360 }, false)
    menu.remove()
    await frame()
    expect(fake.source.place).toHaveBeenLastCalledWith({ x: 0, y: 100, width: 640, height: 360 }, true)
  })

  it('shows the still is being taken and blocks a second click', async () => {
    const fake = fakeSource()
    let finish!: () => void
    vi.mocked(fake.source.still).mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ ok: true, still: {
        frame: { pixels: new Uint8ClampedArray(4), width: 1, height: 1, mediaTime: 0, wallTime: 0 },
        native: true, videoId: 'swMquqtyh-A', approxTime: 1,
      } })
    }))
    const handlers = await opened(fake)
    fake.push(fake.state())
    fireEvent.click(screen.getByRole('button', { name: '截当前画面' }))
    expect(screen.getByRole('button', { name: '正在截取…' })).toBeDisabled()
    await act(async () => { finish() })
    expect(handlers.onStill).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '截当前画面' })).toBeEnabled()
  })

  it('reports a refused page in plain words', async () => {
    const fake = fakeSource()
    vi.mocked(fake.source.open).mockResolvedValueOnce({ ok: false, error: 'bot-challenge' })
    await opened(fake)
    expect(screen.getByRole('alert')).toHaveTextContent('YouTube 要求验证')
  })

  it('opens a finished download once, and lets a running one be cancelled', async () => {
    const fake = fakeSource()
    const handlers = await opened(fake)
    const job: YouTubeClipJob = { jobId: 'j1', videoId: 'swMquqtyh-A', title: 'T', startSeconds: 750, endSeconds: 930, state: 'downloading', progress: 0.4 }
    fake.pushJobs([job])
    expect(screen.getByText('正在下载 40%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(fake.source.cancelClip).toHaveBeenCalledWith('j1')
    const ready = { ...job, state: 'ready' as const, progress: 1, width: 3840, height: 2160, mediaUrl: 'app://app/admin-media/a1' }
    fake.pushJobs([ready])
    fake.pushJobs([ready])
    expect(handlers.onClipReady).toHaveBeenCalledTimes(1)
  })

  it('closes the page when the editor goes away', async () => {
    const fake = fakeSource()
    await opened(fake)
    cleanup()
    expect(fake.source.close).toHaveBeenCalled()
  })
})

describe('clock', () => {
  it('writes time the way YouTube does', () => {
    expect(clock(59)).toBe('0:59')
    expect(clock(754)).toBe('12:34')
    expect(clock(3725)).toBe('1:02:05')
  })
})
