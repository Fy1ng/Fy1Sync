import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { containedPath, NativePrivatePermissions, privateDirectory, type PrivatePermissions } from './privateStorage'

export interface CaptureSettings { version: 1; enabled: boolean }
export interface GifOptions { fps: number; seconds: number; width: number }
export interface GifRecording { id: string; frames: number; maxFrames: number; options: GifOptions; phase: 'recording' | 'encoding' }
export interface CaptureExport { status: 'saved' | 'cancelled'; path: string | null }
export interface GifEncoderInput { directory: string; output: string; fps: number; width: number }
interface Job { view: GifRecording; directory: string; controller: AbortController; accepted: number; bytes: number; work: Promise<void> }
export class CaptureError extends Error {
  constructor(readonly code: 'disabled' | 'invalid-arguments' | 'capture-busy' | 'recording-not-found' | 'cancelled' | 'capture-failed') {
    super({ disabled: '截图和 GIF 功能已关闭', 'invalid-arguments': '截图或 GIF 参数无效', 'capture-busy': '已有 GIF 录制任务',
      'recording-not-found': 'GIF 录制不存在', cancelled: '录制已取消', 'capture-failed': '图片保存或 GIF 编码失败' }[code])
  }
}
export interface MediaCaptureOptions {
  root: string
  load: () => unknown
  save: (settings: CaptureSettings) => void
  chooseDestination: (kind: 'png' | 'gif') => Promise<string | null>
  encode: (input: GifEncoderInput, signal: AbortSignal) => Promise<void>
  validatePng?: (bytes: Buffer) => boolean
  permissions?: PrivatePermissions
}

/** Frames originate from the actual playhead. No screen, arbitrary URL or path can be read. */
export class MediaCapture {
  private settings: CaptureSettings = { version: 1, enabled: false }
  private readonly jobs = new Map<string, Job>()
  private readonly permissions: PrivatePermissions
  private disposed = false
  private screenshotBusy = false
  constructor(private readonly options: MediaCaptureOptions) {
    this.permissions = options.permissions ?? new NativePrivatePermissions()
    const raw = options.load()
    if (raw !== undefined) {
      if (!raw || typeof raw !== 'object' || Object.keys(raw).sort().join(',') !== 'enabled,version'
        || (raw as CaptureSettings).version !== 1 || typeof (raw as CaptureSettings).enabled !== 'boolean') throw new CaptureError('capture-failed')
      this.settings = { ...(raw as CaptureSettings) }
    }
  }
  state(): { settings: CaptureSettings; recordings: GifRecording[] } {
    return { settings: { ...this.settings }, recordings: [...this.jobs.values()].map(job => structuredClone(job.view)) }
  }
  async configure(enabled: boolean): Promise<ReturnType<MediaCapture['state']>> {
    if (typeof enabled !== 'boolean' || this.disposed) throw new CaptureError('invalid-arguments')
    const next: CaptureSettings = { version: 1, enabled }
    this.options.save(next)
    this.settings = next
    if (!enabled) await Promise.all([...this.jobs.keys()].map(id => this.cancel(id)))
    return this.state()
  }
  async screenshot(png: string): Promise<CaptureExport> {
    this.enabled()
    if (this.screenshotBusy) throw new CaptureError('capture-busy')
    const bytes = this.png(png)
    this.screenshotBusy = true
    try {
      const destination = await this.options.chooseDestination('png')
      if (destination === null) return { status: 'cancelled', path: null }
      this.enabled()
      this.destination(destination, '.png')
      await fs.writeFile(destination, bytes)
      return { status: 'saved', path: destination }
    } catch (error) { throw error instanceof CaptureError ? error : new CaptureError('capture-failed') }
    finally { this.screenshotBusy = false }
  }
  begin(raw: GifOptions): GifRecording {
    this.enabled()
    if (this.jobs.size) throw new CaptureError('capture-busy')
    if (!raw || Object.keys(raw).sort().join(',') !== 'fps,seconds,width'
      || !Number.isInteger(raw.fps) || raw.fps < 1 || raw.fps > 15
      || !Number.isInteger(raw.seconds) || raw.seconds < 1 || raw.seconds > 30
      || !Number.isInteger(raw.width) || raw.width < 160 || raw.width > 1280) throw new CaptureError('invalid-arguments')
    const id = randomUUID()
    const directory = privateDirectory(this.options.root, path.join(this.options.root, 'capture-jobs', id), this.permissions)
    const view: GifRecording = { id, frames: 0, maxFrames: raw.fps * raw.seconds, options: { ...raw }, phase: 'recording' }
    this.jobs.set(id, { view, directory, controller: new AbortController(), accepted: 0, bytes: 0, work: Promise.resolve() })
    return structuredClone(view)
  }
  async append(id: string, index: number, png: string): Promise<GifRecording> {
    this.enabled()
    const job = this.job(id)
    if (job.view.phase !== 'recording' || index !== job.accepted || job.accepted >= job.view.maxFrames) throw new CaptureError('invalid-arguments')
    const bytes = this.png(png)
    if (job.bytes + bytes.byteLength > 96 * 1024 * 1024) throw new CaptureError('invalid-arguments')
    job.accepted++; job.bytes += bytes.byteLength
    const filename = containedPath(job.directory, path.join(job.directory, `frame-${String(index).padStart(4, '0')}.png`))
    job.work = job.work.then(async () => {
      this.current(job)
      await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 })
      this.current(job)
      job.view.frames++
    })
    void job.work.catch(() => {})
    await job.work
    return structuredClone(job.view)
  }
  async finish(id: string): Promise<CaptureExport> {
    this.enabled()
    const job = this.job(id)
    if (job.view.phase !== 'recording' || job.accepted < 2) throw new CaptureError('invalid-arguments')
    job.view.phase = 'encoding'
    const output = containedPath(job.directory, path.join(job.directory, 'recording.gif'))
    try {
      await job.work
      this.current(job)
      const destination = await this.options.chooseDestination('gif')
      if (destination === null) return { status: 'cancelled', path: null }
      this.destination(destination, '.gif')
      this.current(job)
      job.work = this.options.encode({ directory: job.directory, output, fps: job.view.options.fps, width: job.view.options.width }, job.controller.signal)
      void job.work.catch(() => {})
      await job.work
      this.current(job)
      const stat = await fs.stat(output)
      if (!stat.isFile() || stat.size < 6 || stat.size > 64 * 1024 * 1024) throw new CaptureError('capture-failed')
      const bytes = await fs.readFile(output)
      if (!['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) throw new CaptureError('capture-failed')
      this.current(job)
      await fs.writeFile(destination, bytes)
      return { status: 'saved', path: destination }
    } catch (error) { throw error instanceof CaptureError ? error : new CaptureError('capture-failed') }
    finally { this.jobs.delete(id); await this.cleanup(job) }
  }
  async cancel(id: string): Promise<{ cancelled: boolean }> {
    const job = this.jobs.get(id)
    if (!job) return { cancelled: false }
    job.controller.abort()
    this.jobs.delete(id)
    await job.work.catch(() => {})
    await this.cleanup(job)
    return { cancelled: true }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.jobs.keys()].map(id => this.cancel(id)))
  }
  private job(id: string): Job { const job = this.jobs.get(id); if (!job) throw new CaptureError('recording-not-found'); return job }
  private enabled(): void { if (this.disposed || !this.settings.enabled) throw new CaptureError('disabled') }
  private current(job: Job): void {
    this.enabled()
    if (job.controller.signal.aborted || this.jobs.get(job.view.id) !== job) throw new CaptureError('cancelled')
  }
  private png(value: string): Buffer {
    if (typeof value !== 'string') throw new CaptureError('invalid-arguments')
    const raw = value.startsWith('data:image/png;base64,') ? value.slice(22) : value
    if (raw.length > 11_184_812 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) throw new CaptureError('invalid-arguments')
    const bytes = Buffer.from(raw, 'base64')
    if (bytes.length < 33 || bytes.length > 8 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') throw new CaptureError('invalid-arguments')
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
    if (!width || !height || width > 4096 || height > 4096 || width * height > 8_847_360
      || (this.options.validatePng && !this.options.validatePng(bytes))) throw new CaptureError('invalid-arguments')
    return bytes
  }
  private destination(value: string, extension: string): void {
    if (!path.isAbsolute(value) || path.extname(value).toLowerCase() !== extension) throw new CaptureError('invalid-arguments')
  }
  private async cleanup(job: Job): Promise<void> {
    const root = path.resolve(this.options.root, 'capture-jobs')
    const directory = containedPath(this.options.root, job.directory)
    if (path.dirname(directory) !== root || path.basename(directory) !== job.view.id) throw new CaptureError('capture-failed')
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 2 })
  }
}

export function encodeGifWithFfmpeg(executable: string, input: GifEncoderInput, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new CaptureError('cancelled'))
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-framerate', String(input.fps),
      '-i', path.join(input.directory, 'frame-%04d.png'), '-filter_complex',
      `[0:v]scale=${input.width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer`,
      '-loop', '0', input.output], { windowsHide: true, shell: false, stdio: 'ignore' })
    let settled = false
    const finish = (error?: CaptureError) => {
      if (settled) return; settled = true
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (error) reject(error); else resolve()
    }
    const abort = () => { child.kill('SIGKILL') }
    const timer = setTimeout(abort, 60_000)
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', () => finish(new CaptureError('capture-failed')))
    child.once('close', code => finish(signal.aborted ? new CaptureError('cancelled') : code === 0 ? undefined : new CaptureError('capture-failed')))
    if (signal.aborted) abort()
  })
}
