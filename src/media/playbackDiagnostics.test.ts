import { describe, expect, it } from 'vitest'
import { PlaybackDiagnostics, playbackBufferAt, type PlaybackDiagnosticInput } from './playbackDiagnostics'

const sample = (at: number, fields: Partial<PlaybackDiagnosticInput> = {}): PlaybackDiagnosticInput => ({
  at, currentTime: 10, paused: false, seeking: false, ended: false, readyState: 2,
  buffered: [[0, 10]], seekableStart: 0, seekableEnd: 10, playlistStart: 0, playlistEnd: 10,
  fragment: null, error: null, droppedFrames: 0, timerLateMs: 0,
  localBuffer: { state: 'ready', seconds: 10, completeSegments: 5 }, observing: true, ...fields,
})

function stalled(fields: Partial<PlaybackDiagnosticInput> = {}) {
  const diagnostics = new PlaybackDiagnostics()
  diagnostics.record('official', sample(0, fields))
  diagnostics.record('official', sample(1500, fields))
  diagnostics.startStall('official')
  return diagnostics
}

describe('bounded playback diagnostics', () => {
  it('stores at most one sample a second and keeps the latest 120 seconds per role', () => {
    const diagnostics = new PlaybackDiagnostics()
    for (let at = 0; at <= 130_000; at += 500) {
      diagnostics.record('official', sample(at, { currentTime: at / 1000 }))
      diagnostics.record('commentary', sample(at, { currentTime: 100 + at / 1000 }))
    }
    const data = diagnostics.export()
    expect(data.official.samples).toHaveLength(120)
    expect(data.commentary.samples).toHaveLength(120)
    expect(data.official.samples[0]!.at).toBe(11_000)
    expect(data.official.samples.at(-1)!.at).toBe(130_000)
    expect(data.official.samples.at(-1)!.mediaProgress).toBe(0.5)
    expect(data.commentary.samples.at(-1)!.currentTime).toBe(230)
  })

  it('expires samples across timer gaps without inventing progress', () => {
    const diagnostics = new PlaybackDiagnostics()
    diagnostics.record('official', sample(2000))
    diagnostics.record('official', sample(202_000, { timerLateMs: 199_500 }))
    expect(diagnostics.export().official.samples).toHaveLength(1)
    expect(diagnostics.export().official.samples[0]).toMatchObject({ at: 200_000, intervalMs: 200_000, timerLateMs: 199_500 })
  })

  it('retains the latest stall boundaries after its history falls out of the ring', () => {
    const diagnostics = stalled()
    diagnostics.record('official', sample(3500, { currentTime: 11, droppedFrames: 4 }))
    diagnostics.endStall('official')
    const stall = diagnostics.export().official.lastStall
    expect(stall).toMatchObject({ durationMs: 3500, ongoing: false,
      start: { at: 0, currentTime: 10 }, end: { at: 3500, currentTime: 11, droppedFramesDelta: 4 } })
    diagnostics.record('official', sample(150_000, { currentTime: 150 }))
    expect(diagnostics.export().official.lastStall).toEqual(stall)
    expect(diagnostics.summary('official')).toMatchObject({ durationMs: 3500, ongoing: false })
    diagnostics.reset('official')
    expect(diagnostics.summary('official')).toBeNull()
    expect(diagnostics.export().official.samples).toEqual([])
  })

  it('takes only the current buffered segment and exposes the next segment across a hole', () => {
    expect(playbackBufferAt([[0, 10], [20, 80]], 9)).toEqual({ bufferAhead: 1, bufferedStart: 0, bufferedEnd: 10, nextBufferedStart: 20 })
    expect(playbackBufferAt([[0, 10], [20, 80]], 15)).toEqual({ bufferAhead: 0, bufferedStart: null, bufferedEnd: null, nextBufferedStart: 20 })
    expect(playbackBufferAt([[0, 10], [20, 80]], 10.1).bufferAhead).toBe(0)
  })

  it('keeps the first sustained progress snapshot as the end instead of adding the confirmation wait', () => {
    const diagnostics = stalled()
    diagnostics.record('official', sample(2000, { currentTime: 10.5 }))
    diagnostics.record('official', sample(2500, { currentTime: 11 }))
    diagnostics.endStall('official')
    expect(diagnostics.export().official.lastStall).toMatchObject({ durationMs: 2000, end: { at: 2000, currentTime: 10.5 } })
  })

  it('tracks playlist and seekable progress even when retained seconds and segment counts are constant', () => {
    const diagnostics = new PlaybackDiagnostics()
    diagnostics.record('official', sample(0))
    diagnostics.record('official', sample(2000, { seekableEnd: 12, playlistEnd: 12 }))
    diagnostics.record('official', sample(3000, { seekableEnd: 12, playlistEnd: 12 }))
    expect(diagnostics.export().official.samples.at(-1)).toMatchObject({ seekableUnchangedMs: 1000, playlistUnchangedMs: 1000 })
  })
})

describe('evidence-based stall hints', () => {
  it('reports stalled local production only with exhausted data and unchanged edges', () => {
    const diagnostics = stalled()
    expect(diagnostics.summary('official')).toMatchObject({ category: 'production', hint: expect.stringContaining('本地产片没推进') })
    expect(stalled({ localBuffer: null }).summary('official')!.category).toBe('unknown')
    expect(stalled({ seekableEnd: null, playlistEnd: null }).summary('official')!.category).toBe('unknown')
  })

  it('reports local data not fetched only when a pending or failed request supports it', () => {
    expect(stalled({ seekableEnd: 20, playlistEnd: 20, fragment: { phase: 'loading', elapsedMs: 2000 } })
      .summary('official')).toMatchObject({ category: 'fetch', hint: expect.stringContaining('本地有数据但播放器没拉到') })
    expect(stalled({ seekableEnd: 20, playlistEnd: 20, error: { type: 'networkError', details: 'fragLoadError' } })
      .summary('official')!.category).toBe('fetch')
    expect(stalled({ seekableEnd: 20, playlistEnd: 20 }).summary('official')!.category).toBe('unknown')
    expect(stalled({ seekableStart: 11, seekableEnd: 20, playlistEnd: 20, fragment: { phase: 'loading', elapsedMs: 2000 } })
      .summary('official')!.category).toBe('unknown')
    expect(stalled({ seekableEnd: 30, playlistEnd: 30, fragment: { phase: 'loading', elapsedMs: 2000, start: 20, end: 22 } })
      .summary('official')!.category).toBe('unknown')
    expect(stalled({ seekableEnd: 20, playlistEnd: 20, error: { type: 'networkError', details: 'fragLoadError', ageMs: 6000 } })
      .summary('official')!.category).toBe('unknown')
  })

  it('reports data at the playhead or an unfinished append without claiming a decoding root cause', () => {
    expect(stalled({ buffered: [[0, 15]], readyState: 4 }).summary('official'))
      .toMatchObject({ category: 'playback', hint: expect.stringContaining('数据已到但画面不动') })
    expect(stalled({ fragment: { phase: 'loaded', elapsedMs: 2000, start: 9, end: 11 } }).summary('official')!.category).toBe('playback')
    expect(stalled({ seekableEnd: 30, playlistEnd: 30, fragment: { phase: 'loaded', elapsedMs: 2000, start: 20, end: 22 } })
      .summary('official')!.category).toBe('unknown')
    expect(stalled({ buffered: [[0, 9], [20, 80]], seekableEnd: 80, playlistEnd: 80 })
      .summary('official')!.category).toBe('unknown')
  })

  it('prioritizes a late renderer timer over apparent playback failure', () => {
    const diagnostics = stalled({ buffered: [[0, 30]], timerLateMs: 1200 })
    expect(diagnostics.summary('official')).toMatchObject({ category: 'thread', hint: expect.stringContaining('界面线程繁忙') })
    diagnostics.record('official', sample(2500, { currentTime: 11 }))
    diagnostics.endStall('official')
    expect(diagnostics.summary('official')!.category).toBe('thread')
  })

  it.each([{ paused: true }, { seeking: true }, { ended: true }, { observing: false }])('excludes deliberate playback boundaries: %o', fields => {
    expect(stalled({ ...fields, buffered: [[0, 30]] }).summary('official')!.category).toBe('unknown')
  })

  it('does not classify a progressing media clock from full buffers or dropped frames alone', () => {
    const diagnostics = new PlaybackDiagnostics()
    diagnostics.record('official', sample(0, { buffered: [[0, 30]] }))
    diagnostics.record('official', sample(1500, { buffered: [[0, 30]], currentTime: 11.5, droppedFrames: 10 }))
    diagnostics.startStall('official')
    expect(diagnostics.summary('official')!.category).toBe('unknown')
  })
})

describe('diagnostic export allowlist', () => {
  it('omits addresses, credentials, paths and arbitrary third-party fields at every level', () => {
    const secret = 'https://private.invalid/room?token=secret'
    const input = { ...sample(1000), descriptor: { url: secret, label: 'Private room' }, cookie: 'secret-cookie',
      path: 'C:\\Users\\private\\secret', headers: { Authorization: 'secret-token' },
      fragment: { phase: 'loading' as const, elapsedMs: 50, url: secret, headers: { Cookie: 'secret' } },
      error: { type: secret, details: secret, response: { url: secret } },
      localBuffer: { state: 'ready' as const, seconds: 10, reason: secret, failure: { message: secret } },
    }
    const diagnostics = new PlaybackDiagnostics()
    diagnostics.record('official', input)
    diagnostics.startStall('official')
    diagnostics.record('official', { ...input, at: 2500 })
    diagnostics.endStall('official')
    const data = diagnostics.export()
    const text = JSON.stringify(data)
    for (const field of ['https:', 'private', 'secret', 'Cookie', 'Authorization', 'descriptor', 'url', 'headers', 'response', 'failure', 'reason', 'path']) expect(text).not.toContain(field)
    expect(data.official.samples[0]!.at).toBe(0)
    expect(data.official.samples[0]!.error).toEqual({ type: null, details: null, ageMs: 0 })
    expect(data.official.samples[0]!.fragment).toEqual({ phase: 'loading', elapsedMs: 50, start: null, end: null, loadMs: null })
    expect(data.commentary).toEqual({ samples: [], lastStall: null })
    data.official.samples[0]!.currentTime = 900
    expect(diagnostics.export().official.samples[0]!.currentTime).toBe(10)
  })

  it('keeps known error enums and discards unexpected enum-like strings', () => {
    const diagnostics = new PlaybackDiagnostics()
    diagnostics.record('official', sample(0, { error: { type: 'networkError', details: 'fragLoadTimeOut' } }))
    diagnostics.record('official', sample(1000, { error: { type: 'secretRoom', details: 'accountToken' } }))
    expect(diagnostics.export().official.samples.map(item => item.error)).toEqual([
      { type: 'networkError', details: 'fragLoadTimeOut', ageMs: 0 }, { type: null, details: null, ageMs: 0 },
    ])
  })
})
