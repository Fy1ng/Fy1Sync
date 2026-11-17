/**
 * The editor's view of main's YouTube browsing and clip download, behind `YouTubeSource`.
 *
 * Null when this build of main does not offer them, so the editor shows local files only
 * rather than a source that fails on every click.
 */

import type { ApiResult } from '../../app/apiClient'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { YtBrowseState, YtImportJob } from '../../../electron/ytAdminContracts'
import { YOUTUBE_ERROR_TEXT, type YouTubeBrowseState, type YouTubeClipJob, type YouTubeError, type YouTubeSource } from './YouTubePanel'
import { displayError, errorDetails, errorMessage } from '../../core/errorDetails'

/** Main's codes the panel has words for; anything else reads as a plain failure. */
function errorOf(code: string | null | undefined): YouTubeError {
  if (code === 'invalid-arguments') return 'invalid-url'
  return code && Object.hasOwn(YOUTUBE_ERROR_TEXT, code) ? code as YouTubeError : 'failed'
}

function browseState(state: YtBrowseState): YouTubeBrowseState | null {
  // Nothing open: main reports an empty page as closed.
  if (!state.videoId) return null
  return {
    videoId: state.videoId, title: state.title, duration: state.duration, currentTime: state.currentTime,
    playing: state.playing, videoWidth: state.videoWidth, videoHeight: state.videoHeight,
    advert: state.isAd, playerOnly: state.playerOnly, error: state.errorCode ? errorOf(state.errorCode) : null,
    ...(state.errorCode ? { errorDetail: errorDetails(state) } : {}),
  }
}

function clipJob(job: YtImportJob): YouTubeClipJob {
  const percent = job.progress?.percent
  return {
    jobId: job.jobId, videoId: job.videoId, title: job.title ?? '', startSeconds: job.startSeconds, endSeconds: job.endSeconds,
    state: job.state, progress: typeof percent === 'number' ? percent / 100 : null,
    width: job.format?.width, height: job.format?.height, targetHeight: job.targetHeight,
    error: job.error ? errorOf(job.error.code) : undefined, mediaUrl: job.mediaUrl,
    ...(job.error ? { errorDetail: errorDetails(job.error) } : {}),
    assetId: job.assetId,
  }
}

export function youtubeSource(bridge: StreamSyncerBridge | undefined = typeof window !== 'undefined' ? window.streamSyncer : undefined): YouTubeSource | null {
  if (!bridge?.subscribeYtBrowseState || !bridge.subscribeYtImportProgress) return null
  const api = bridge
  const errorListeners = new Set<(error: unknown) => void>()
  let latestError: unknown = null
  const report = (error: unknown, summary: string): void => {
    const failure = displayError(error, summary)
    latestError = errorListeners.size ? null : failure
    for (const listener of errorListeners) listener(failure)
  }
  const call = async <T>(run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
    try { return await run() } catch (caught) { return { ok: false, code: 'failed', message: errorMessage(caught), detail: errorDetails(caught) } }
  }

  return {
    async open(url) {
      const result = await call(() => api.invoke('ytBrowseOpen', { url }))
      return result.ok ? { ok: true } : { ok: false, error: errorOf(result.code), detail: result }
    },
    async close() { const result = await call(() => api.invoke('ytBrowseClose', undefined)); if (!result.ok) report(result, '关闭录像失败, 请重试.') },
    async place(rect, visible) { const result = await call(() => api.invoke('ytBrowseSetViewport', { rect, visible })); if (!result.ok) report(result, '录像窗口位置更新失败, 请重试.') },
    subscribe(listener) {
      const off = api.subscribeYtBrowseState!((next) => listener(browseState(next)))
      void call(() => api.invoke('ytBrowseState', undefined)).then((result) => { if (result.ok) listener(browseState(result.value)); else report(result, '读取录像状态失败, 请重试.') })
      return off
    },
    async now() {
      const result = await call(() => api.invoke('ytBrowseState', undefined))
      if (!result.ok) report(result, '读取录像位置失败, 请重试.')
      return result.ok ? browseState(result.value) : null
    },
    async still() {
      const result = await call(() => api.invoke('ytBrowseSnapshot', undefined))
      if (!result.ok) return { ok: false, error: errorOf(result.code), detail: result }
      const shot = result.value
      // Main checked the length against the size; the bytes are the frame as it is.
      const pixels = new Uint8ClampedArray(shot.rgba.buffer, shot.rgba.byteOffset, shot.rgba.byteLength)
      return { ok: true, still: {
        frame: { pixels, width: shot.width, height: shot.height, mediaTime: shot.approximateTime, wallTime: Date.now() },
        native: shot.isOneToOne, videoId: shot.videoId, approxTime: shot.approximateTime,
      } }
    },
    async startClip(url, startSeconds, endSeconds, targetHeight) {
      const result = await call(() => api.invoke('ytImportStart', { url, startSeconds, endSeconds, targetHeight }))
      return result.ok ? { ok: true, jobId: result.value.jobId } : { ok: false, error: errorOf(result.code), detail: result }
    },
    async cancelClip(jobId) { const result = await call(() => api.invoke('ytImportCancel', { jobId })); if (!result.ok) report(result, '取消下载失败, 请重试.') },
    subscribeClips(listener) {
      const jobs = new Map<string, YouTubeClipJob>()
      const emit = () => listener([...jobs.values()].reverse())
      const off = api.subscribeYtImportProgress!((job) => { jobs.set(job.jobId, clipJob(job)); emit() })
      void call(() => api.invoke('ytImportList', undefined)).then((result) => {
        if (!result.ok) { report(result, '读取下载任务失败, 请重试.'); return }
        for (const job of result.value) if (!jobs.has(job.jobId)) jobs.set(job.jobId, clipJob(job))
        emit()
      })
      return off
    },
    subscribeErrors(listener) {
      errorListeners.add(listener)
      if (latestError !== null) { listener(latestError); latestError = null }
      return () => { errorListeners.delete(listener) }
    },
  }
}
