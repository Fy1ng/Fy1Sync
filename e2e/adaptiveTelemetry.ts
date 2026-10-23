import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import type { BufferState } from '../electron/bufferManager'

type DecoderInfo = { codec?: string; decoder?: string; platform?: boolean; events?: Record<string, number>; errors?: { type: string; code: number }[]; buffering?: { track: string; state?: string; reason?: string }[] }

/** Select only non-identifying media properties, never CDP URLs or raw events. */
export async function decoderTelemetry(page: Page, app: ElectronApplication) {
  const info: DecoderInfo = { events: {}, errors: [], buffering: [] }
  const players: Record<string, DecoderInfo> = {}
  const cdp = await app.context().newCDPSession(page)
  cdp.on('Media.playerPropertiesChanged', (event: { playerId: string; properties: { name: string; value: string }[] }) => {
    const player = players[event.playerId] ??= {}
    for (const property of event.properties) {
      if (property.name === 'kVideoDecoderName' && /^[a-z0-9_. -]{1,100}$/i.test(property.value)) player.decoder = info.decoder = property.value
      if (property.name === 'kIsPlatformVideoDecoder') player.platform = info.platform = property.value === 'true'
      if (property.name === 'kVideoTracks') {
        const codec = /\b(vp9|vp09|av1|av01|h264)\b/i.exec(property.value)?.[1]
        if (codec) player.codec = info.codec = codec.toLowerCase()
      }
    }
  })
  cdp.on('Media.playerEventsAdded', (event: { events: { value: string }[] }) => {
    for (const item of event.events) {
      let value: unknown
      try { value = JSON.parse(item.value) } catch { continue }
      if (!value || typeof value !== 'object' || !('event' in value) || typeof value.event !== 'string' || !/^k[A-Za-z]{1,80}$/.test(value.event)) continue
      info.events![value.event] = (info.events![value.event] ?? 0) + 1
      if (value.event === 'kBufferingStateChanged') {
        for (const track of ['audio_buffering_state', 'video_buffering_state', 'pipeline_buffering_state']) {
          const state = (value as Record<string, unknown>)[track]
          if (!state || typeof state !== 'object' || info.buffering!.length >= 100) continue
          const safe = (key: string) => {
            const field = (state as Record<string, unknown>)[key]
            return typeof field === 'string' && /^[A-Z0-9_ -]{1,80}$/.test(field) ? field : undefined
          }
          info.buffering!.push({ track, state: safe('state'), reason: safe('reason') })
        }
      }
    }
  })
  cdp.on('Media.playerErrorsRaised', (event: { errors: { errorType: string; code: number }[] }) => {
    for (const error of event.errors) {
      if (/^[a-z0-9_ -]{1,80}$/i.test(error.errorType) && Number.isSafeInteger(error.code) && info.errors!.length < 100) info.errors!.push({ type: error.errorType, code: error.code })
    }
  })
  await cdp.send('Media.enable')
  return { info, players, close: () => cdp.detach() }
}

export function playbackObservationSeconds(env = process.env): number {
  const seconds = Number(env.STREAM_SYNC_ADAPTIVE_SECONDS ?? 30)
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 7200) throw new Error('STREAM_SYNC_ADAPTIVE_SECONDS 必须是10到7200之间的整数')
  if (seconds > 120 && env.STREAM_SYNC_ADAPTIVE_LONG !== '1') throw new Error('超过120秒的测试还需显式设置 STREAM_SYNC_ADAPTIVE_LONG=1')
  return seconds
}

/** Observe the real player and verify every newly published local fragment is readable. */
export async function observeAdaptivePlayback(page: Page, localUrl: string, seconds: number, decoder: DecoderInfo, testInfo: TestInfo, expectedFps = 0) {
  const capture = process.env.STREAM_SYNC_ADAPTIVE_CAPTURE === '1'
  const captureDir = testInfo.outputPath('local-media')
  const captureLines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
  let captureBytes = 0
  let captureDuration = 0
  let captureInit = ''
  await page.evaluate(() => {
    const telemetry = { events: {} as Record<string, number>, observedReconnects: 0, observedFallback: false,
      longTasks: 0, longTaskMs: 0, maxLongTaskMs: 0, visibilityChanges: 0 }
    const scope = window as unknown as { __adaptiveBufferState?: BufferState; __adaptiveTelemetry?: typeof telemetry; __adaptiveCleanup?: () => void }
    scope.__adaptiveTelemetry = telemetry
    const release = window.streamSyncer?.subscribeBuffer?.(state => {
      if (state.role !== 'official') return
      scope.__adaptiveBufferState = state
      if (['stalled', 'reconnecting', 'failed', 'stopped'].includes(state.state)) telemetry.observedReconnects++
      if (state.notice) telemetry.observedFallback = true
    })
    const video = document.querySelector<HTMLVideoElement>('video[data-role="official"]')
    const events = ['waiting', 'stalled', 'playing', 'pause', 'seeking', 'seeked', 'ratechange', 'error']
    const count = (event: Event) => { telemetry.events[event.type] = (telemetry.events[event.type] ?? 0) + 1 }
    events.forEach(name => video?.addEventListener(name, count))
    const visibility = () => { telemetry.visibilityChanges++ }
    document.addEventListener('visibilitychange', visibility)
    let observer: PerformanceObserver | undefined
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          telemetry.longTasks++
          telemetry.longTaskMs += entry.duration
          telemetry.maxLongTaskMs = Math.max(telemetry.maxLongTaskMs, entry.duration)
        }
      })
      observer.observe({ type: 'longtask' })
    }
    scope.__adaptiveCleanup = () => {
      release?.(); observer?.disconnect()
      events.forEach(name => video?.removeEventListener(name, count))
      document.removeEventListener('visibilitychange', visibility)
    }
  })
  const sample = () => page.evaluate(async url => {
    const video = document.querySelector<HTMLVideoElement>('video[data-role="official"]')
    if (!video) throw new Error('官方视频元素缺失')
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) throw new Error('本地播放列表不可读')
    const text = await response.text()
    const firstSequence = Number(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m.exec(text)?.[1] ?? -1)
    const fragments = text.split(/\r?\n/).filter(line => line && !line.startsWith('#'))
    const durations = [...text.matchAll(/^#EXTINF:([\d.]+)/gm)].map(match => Number(match[1]))
    const inits = [...new Set([...text.matchAll(/^#EXT-X-MAP:URI="(init_\d+\.mp4)"/gm)].map(match => match[1]!))]
    if (!Number.isSafeInteger(firstSequence) || firstSequence < 0 || !inits.length || !fragments.length
      || fragments.some(name => !/^segment_\d+_\d{9}\.m4s$/.test(name))) throw new Error('本地缓冲不是预期的fMP4播放列表')
    const quality = video.getVideoPlaybackQuality()
    let maxBufferedGap = 0
    let bufferAhead = 0
    for (let i = 1; i < video.buffered.length; i++) maxBufferedGap = Math.max(maxBufferedGap, video.buffered.start(i) - video.buffered.end(i - 1))
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) bufferAhead = video.buffered.end(i) - video.currentTime
    }
    return {
      wallMs: performance.now(), time: video.currentTime, width: video.videoWidth, height: video.videoHeight,
      total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames, paused: video.paused, error: video.error?.code ?? null,
      readyState: video.readyState, maxBufferedGap, bufferAhead, playbackRate: video.playbackRate,
      visibility: document.visibilityState, focused: document.hasFocus(),
      telemetry: (window as unknown as { __adaptiveTelemetry?: { events: Record<string, number>; observedReconnects: number; observedFallback: boolean; longTasks: number; longTaskMs: number; maxLongTaskMs: number; visibilityChanges: number } }).__adaptiveTelemetry,
      firstSequence, fragments, inits, durations, bufferedSeconds: durations.reduce((sum, duration) => sum + duration, 0),
      state: (window as unknown as { __adaptiveBufferState?: BufferState }).__adaptiveBufferState ?? null,
    }
  }, localUrl)
  type Sample = Awaited<ReturnType<typeof sample>>
  const samples: Omit<Sample, 'fragments' | 'inits' | 'durations'>[] = []
  const seenInit = new Set<string>()
  let nextSequence: number | undefined
  let checkedFragments = 0
  let missingFragments = 0
  const first = await sample()
  const deadline = first.wallMs + seconds * 1000
  let previous = first
  let complete = false
  try {
    while (true) {
      const current = samples.length ? await sample() : first
      const { fragments, inits, durations, ...metrics } = current
      samples.push(metrics)
      if (current.height !== 1440 || current.error || current.paused) throw new Error('持续播放失去1440p画面或发生视频错误/暂停')
      if (current.state?.notice || ['stalled', 'reconnecting', 'failed', 'stopped'].includes(current.state?.state ?? '')) throw new Error('持续播放发生回退、停滞或重连')
      if (current.telemetry?.observedFallback || current.telemetry?.observedReconnects) throw new Error('持续播放曾发生回退、停滞或重连')
      if (current.maxBufferedGap > 0.15) throw new Error('播放器缓冲存在大于150ms的时间间隙')
      if (samples.length > 1 && current.time <= previous.time + 0.1) throw new Error('持续播放在采样间隔内未前进')
      nextSequence ??= current.firstSequence
      if (current.firstSequence > nextSequence) { missingFragments += current.firstSequence - nextSequence; throw new Error('本地播放列表跳过尚未核验的分片序列') }
      const resources = [
        ...inits.filter(name => !seenInit.has(name)),
        ...fragments.filter((_name, index) => current.firstSequence + index >= nextSequence!),
      ]
      const failures = await page.evaluate(async ({ base, names }) => {
        let failures = 0
        for (const name of names) {
          const response = await fetch(base + name, { cache: 'no-store' })
          if (!response.ok || (await response.arrayBuffer()).byteLength === 0) failures++
        }
        return failures
      }, { base: localUrl.slice(0, localUrl.lastIndexOf('/') + 1), names: resources })
      missingFragments += failures
      if (failures) throw new Error('已发布的本地init或媒体分片不可读')
      if (capture && captureDuration < 60) {
        await mkdir(captureDir, { recursive: true })
        for (const name of resources) {
          if (captureDuration >= 60) break
          if (!/^(?:init_\d+\.mp4|segment_\d+_\d{9}\.m4s)$/.test(name)) throw new Error('本地诊断媒体文件名无效')
          const duration = name.startsWith('init_') ? 0 : durations[fragments.indexOf(name)]!
          if (captureDuration + duration > 60) break
          const encoded = await page.evaluate(async target => {
            const response = await fetch(target, { cache: 'no-store' })
            if (!response.ok) throw new Error('本地媒体捕获失败')
            const bytes = new Uint8Array(await response.arrayBuffer())
            let binary = ''
            for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
            return btoa(binary)
          }, localUrl.slice(0, localUrl.lastIndexOf('/') + 1) + name)
          const bytes = Buffer.from(encoded, 'base64')
          captureBytes += bytes.length
          if (captureBytes > 128 * 1024 * 1024) throw new Error('本地诊断媒体超过128MiB上限')
          await writeFile(path.join(captureDir, name), bytes)
          if (name.startsWith('init_')) {
            if (captureInit && captureInit !== name) captureLines.push('#EXT-X-DISCONTINUITY')
            captureInit = name
            captureLines.push(`#EXT-X-MAP:URI="${name}"`)
          } else {
            captureDuration += duration
            captureLines.push(`#EXTINF:${duration},`, name)
          }
        }
      }
      checkedFragments += fragments.filter((_name, index) => current.firstSequence + index >= nextSequence!).length
      inits.forEach(name => seenInit.add(name))
      nextSequence = Math.max(nextSequence, current.firstSequence + fragments.length)
      if (samples.length % 12 === 0) console.log('ADAPTIVE_PROGRESS ' + JSON.stringify({
        elapsedSeconds: Math.round((current.wallMs - first.wallMs) / 1000), mediaSeconds: current.time - first.time,
        height: current.height, totalFrames: current.total - first.total, droppedFrames: current.dropped - first.dropped,
        checkedFragments, missingFragments, decoder,
        bufferAhead: current.bufferAhead, playbackRate: current.playbackRate, visibility: current.visibility, focused: current.focused, telemetry: current.telemetry,
      }))
      if (current.wallMs >= deadline) {
        if (current.time - first.time < seconds - 2) throw new Error('实际媒体播放时长没有覆盖指定连续验收窗口')
        if (expectedFps && (current.total - first.total) / (current.time - first.time) < expectedFps * 0.95) throw new Error('实际视频帧增量未达到指定帧率')
        complete = true
        break
      }
      previous = current
      await page.waitForTimeout(Math.min(5000, Math.max(1, deadline - current.wallMs)))
    }
  } finally {
    if (capture && captureDuration) {
      await writeFile(path.join(captureDir, 'index.m3u8'), [...captureLines, '#EXT-X-ENDLIST'].join('\n') + '\n')
    }
    await page.evaluate(() => { (window as unknown as { __adaptiveCleanup?: () => void }).__adaptiveCleanup?.() }).catch(() => {})
    const last = samples.at(-1) ?? first
    const result = {
      complete, requestedSeconds: seconds, elapsedSeconds: (last.wallMs - first.wallMs) / 1000,
      mediaSeconds: last.time - first.time, totalFrames: last.total - first.total, droppedFrames: last.dropped - first.dropped,
      expectedFps, observedFps: (last.total - first.total) / (last.time - first.time),
      capturedLocalSeconds: captureDuration, capturedLocalBytes: captureBytes,
      decoder, checkedFragments, missingFragments, samples,
    }
    await mkdir(testInfo.outputDir, { recursive: true })
    const file = testInfo.outputPath('adaptive-playback-observation.json')
    await writeFile(file, JSON.stringify(result, null, 2))
    await testInfo.attach('adaptive-playback-observation', { path: file, contentType: 'application/json' })
  }
}
