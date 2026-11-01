import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_CLIP_SECONDS, YOUTUBE_ERROR_TEXT, YouTubePanel, clock, youtubeVideoId, type YouTubeBrowseState, type YouTubeClipJob, type YouTubeSource } from './YouTubePanel'

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

type PanelProps = Pick<React.ComponentProps<typeof YouTubePanel>, 'autoStill' | 'active' | 'onAutoStillChange'>

async function opened(fake: ReturnType<typeof fakeSource>, handlers = { onStill: vi.fn(), onClipReady: vi.fn() }, props: Partial<PanelProps> = {}) {
  render(<YouTubePanel source={fake.source} {...handlers} autoStill={false} active onAutoStillChange={() => {}} {...props} />)
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

  it.each([[3840, 2160], [2560, 1440], [1920, 1080]])('accepts the supported native size %sx%s', async (videoWidth, videoHeight) => {
    const fake = fakeSource()
    await opened(fake)
    fake.push(fake.state({ videoWidth, videoHeight }))
    expect(screen.queryByText(/在播放器的画质菜单里选/)).toBeNull()
    expect(screen.getByText(`${videoWidth}×${videoHeight}`)).toHaveAttribute('data-native', 'true')
  })

  it.each([[1280, 720], [2048, 1080], [7680, 4320], [3840, 1440]])('does not restrict footage to a resolution whitelist: %sx%s', async (videoWidth, videoHeight) => {
    const fake = fakeSource()
    await opened(fake)
    fake.push(fake.state({ videoWidth, videoHeight }))
    expect(screen.queryByText(/在播放器的画质菜单里选/)).not.toBeInTheDocument()
    expect(screen.getByText(/不限制素材分辨率/)).toBeInTheDocument()
    expect(screen.getByText(`${videoWidth}×${videoHeight}`)).toHaveAttribute('data-native', 'true')
  })

  it('hands a still to the editor', async () => {
    const fake = fakeSource()
    const handlers = await opened(fake)
    fake.push(fake.state())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '截当前画面' })) })
    expect(handlers.onStill).toHaveBeenCalledWith(expect.objectContaining({ native: true, videoId: 'swMquqtyh-A' }), false)
  })

  it('takes the frame the player stops on, once per stop, while 自动取帧 is on', async () => {
    const fake = fakeSource()
    const handlers = await opened(fake, undefined, { autoStill: true })
    const settle = (): Promise<void> => act(async () => {})
    fake.push(fake.state({ playing: true, currentTime: 10 }))
    await settle()
    expect(fake.source.still).not.toHaveBeenCalled()
    fake.push(fake.state({ currentTime: 12.5 }))
    await settle()
    expect(fake.source.still).toHaveBeenCalledTimes(1)
    expect(handlers.onStill).toHaveBeenLastCalledWith(expect.objectContaining({ videoId: 'swMquqtyh-A' }), true)
    // The same stop pushed again is not taken twice; a frame step while paused is a new stop.
    fake.push(fake.state({ currentTime: 12.5 }))
    await settle()
    expect(fake.source.still).toHaveBeenCalledTimes(1)
    fake.push(fake.state({ currentTime: 12.517 }))
    await settle()
    expect(fake.source.still).toHaveBeenCalledTimes(2)
  })

  it('takes nothing where a recording opened, while hidden, or with the switch off', async () => {
    for (const props of [{ autoStill: true }, { autoStill: true, active: false }, { autoStill: false }]) {
      const fake = fakeSource()
      await opened(fake, undefined, props)
      fake.push(fake.state({ currentTime: 0 }))
      if (!props.autoStill || props.active === false) {
        fake.push(fake.state({ playing: true, currentTime: 3 }))
        fake.push(fake.state({ currentTime: 4 }))
      }
      await act(async () => {})
      expect(fake.source.still).not.toHaveBeenCalled()
      cleanup()
    }
  })

  it('tries a stop caught mid-seek again on the next state, without a note', async () => {
    const fake = fakeSource()
    vi.mocked(fake.source.still).mockResolvedValueOnce({ ok: false, error: 'snapshot-unavailable' })
    const handlers = await opened(fake, undefined, { autoStill: true })
    fake.push(fake.state({ playing: true, currentTime: 19 }))
    fake.push(fake.state({ currentTime: 20 }))
    await act(async () => {})
    expect(fake.source.still).toHaveBeenCalledTimes(1)
    expect(handlers.onStill).not.toHaveBeenCalled()
    expect(screen.queryByText(YOUTUBE_ERROR_TEXT['snapshot-unavailable'])).toBeNull()
    fake.push(fake.state({ currentTime: 20 }))
    await act(async () => {})
    expect(fake.source.still).toHaveBeenCalledTimes(2)
    expect(handlers.onStill).toHaveBeenCalledTimes(1)
  })

  it('flips 自动取帧 from its switch', async () => {
    const fake = fakeSource()
    const onAutoStillChange = vi.fn()
    await opened(fake, undefined, { autoStill: false, onAutoStillChange })
    fake.push(fake.state())
    fireEvent.click(screen.getByRole('switch', { name: '自动取帧' }))
    expect(onAutoStillChange).toHaveBeenCalledWith(true)
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
    expect(screen.getByRole('combobox', { name: '下载画质' })).toHaveValue('2160')
    expect(fake.source.startClip).toHaveBeenCalledWith('https://www.youtube.com/watch?v=swMquqtyh-A', 750, 930, 2160)

    fake.push(fake.state({ currentTime: 750 + MAX_CLIP_SECONDS + 1 }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /设为出点/ })) })
    expect(screen.getByRole('button', { name: /下载这一段/ })).toBeDisabled()
    expect(screen.getByText('一次最多下载 3 小时')).toBeInTheDocument()
  })

  it.each([3600, MAX_CLIP_SECONDS])('allows a full %s-second match clip', async (duration) => {
    const fake = fakeSource()
    await opened(fake)
    fake.push(fake.state({ duration: 20_000, currentTime: 0 }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /设为入点/ })) })
    fake.push(fake.state({ duration: 20_000, currentTime: duration }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /设为出点/ })) })
    const download = screen.getByRole('button', { name: /下载这一段/ })
    expect(download).toBeEnabled()
    await act(async () => { fireEvent.click(download) })
    expect(fake.source.startClip).toHaveBeenCalledWith('https://www.youtube.com/watch?v=swMquqtyh-A', 0, duration, 2160)
  })

  it.each([2160, 1440, 1080] as const)('downloads the selected %sp independently of the player quality', async (targetHeight) => {
    const fake = fakeSource()
    await opened(fake)
    fake.push(fake.state({ videoWidth: 1920, videoHeight: 1080, currentTime: 750 }))
    const quality = screen.getByRole('combobox', { name: '下载画质' })
    expect(quality).toHaveValue('2160')
    expect(within(quality).getAllByRole('option').map((option) => option.textContent)).toEqual(['2160p', '1440p', '1080p'])
    fireEvent.change(quality, { target: { value: String(targetHeight) } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /设为入点/ })) })
    fake.push(fake.state({ videoWidth: 2560, videoHeight: 1440, currentTime: 930 }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /设为出点/ })) })
    expect(quality).toHaveValue(String(targetHeight))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /下载这一段/ })) })
    expect(fake.source.startClip).toHaveBeenCalledWith('https://www.youtube.com/watch?v=swMquqtyh-A', 750, 930, targetHeight)
  })

  it('names the requested quality when starting the download fails', async () => {
    const fake = fakeSource()
    vi.mocked(fake.source.startClip).mockResolvedValueOnce({ ok: false, error: 'format-unavailable' })
    await opened(fake)
    fireEvent.change(screen.getByRole('combobox', { name: '下载画质' }), { target: { value: '1440' } })
    fake.push(fake.state({ currentTime: 750 }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /设为入点/ })) })
    fake.push(fake.state({ currentTime: 930 }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /设为出点/ })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /下载这一段/ })) })
    expect(screen.getByRole('alert')).toHaveTextContent('这段录像没有 1440p，请换一档画质')
  })

  it.each([2160, 1440, 1080] as const)('keeps %sp in the job status and failure after the selector changes', async (targetHeight) => {
    const fake = fakeSource()
    await opened(fake)
    const job: YouTubeClipJob = { jobId: 'j1', videoId: 'swMquqtyh-A', title: 'T', startSeconds: 750, endSeconds: 930,
      targetHeight, state: 'probing', progress: null }
    fake.pushJobs([job])
    expect(screen.getByText(`正在查找 ${targetHeight}p…`)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: '下载画质' }), { target: { value: targetHeight === 2160 ? '1080' : '2160' } })
    fake.pushJobs([{ ...job, state: 'failed', error: 'format-unavailable' }])
    expect(screen.getByText(`这段录像没有 ${targetHeight}p，请换一档画质`)).toBeInTheDocument()
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
    expect(screen.getByText('已下载 · 3840×2160')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('list', { name: '下载' })).getByRole('button', { name: '打开' }))
    expect(handlers.onClipReady).toHaveBeenLastCalledWith(ready)
    expect(handlers.onClipReady).toHaveBeenCalledTimes(2)
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
