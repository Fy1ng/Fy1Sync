import type { MediaDescriptor } from '../core/types'
import { attachMedia, type MediaAttachment } from './hlsController'
import { PlaybackControls } from './playbackControls'

/** One extra stream owns one stable element; layout and draggable mounts are UI work. */
export class IndependentMedia {
  readonly video: HTMLVideoElement
  readonly controls: PlaybackControls
  private attachment: MediaAttachment | null = null
  private abort: AbortController | null = null
  private generation = 0
  private disposed = false
  private live: boolean | undefined
  constructor(readonly id: string) {
    this.video = document.createElement('video')
    this.video.dataset.streamId = id
    this.video.className = 'media-element'
    this.video.playsInline = true
    this.video.crossOrigin = 'anonymous'
    this.video.muted = true
    this.controls = new PlaybackControls(this.video, () => this.live)
  }
  mount(container: HTMLElement | null): void {
    if (this.disposed || !container) { this.video.remove(); return }
    if (this.video.parentElement !== container) container.appendChild(this.video)
  }
  async load(descriptor: MediaDescriptor): Promise<void> {
    if (this.disposed) throw new Error('播放会话已关闭')
    const revision = ++this.generation
    this.abort?.abort()
    this.attachment?.destroy()
    this.attachment = null
    this.live = undefined
    const controller = new AbortController()
    this.abort = controller
    const attachment = await attachMedia(this.video, descriptor, { onLiveHint: value => {
      if (revision === this.generation) this.live = value
    } }, controller.signal)
    if (revision !== this.generation || this.disposed) attachment.destroy()
    else this.attachment = attachment
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ++this.generation
    this.abort?.abort()
    this.attachment?.destroy()
    this.controls.dispose()
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
    this.video.remove()
  }
}
