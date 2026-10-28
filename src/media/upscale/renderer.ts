import { CNN_M_PASSES as CNN_PASSES } from './anime4k'
import { DegradeController } from './degrade'
import { FSR_WGSL } from './fsr'
import { bufferUsage, gpuEntry, textureUsage, type Descriptor, type GpuBuffer, type GpuContext, type GpuDevice, type GpuPipeline, type GpuQuerySet, type GpuTexture } from './gpu'
import { outputSize, passPlan, type OutputSize, type PixelCrop, type UpscaleTier } from './plan'
import { BILINEAR_WGSL, CROP_WGSL, LOAD_WGSL, VERTEX_WGSL } from './shaders'

export interface UpscaleOptions {
  crop: PixelCrop
  cssWidth: number
  cssHeight: number
  dpr: number
  tier: Exclude<UpscaleTier, 'off'>
}

export interface TimingStats {
  count: number
  p50: number
  p95: number
  max: number
}

export interface UpscaleDiagnostics {
  tier: UpscaleTier
  passes: string[]
  width: number
  height: number
  frames: number
  timing: 'timestamp-query' | 'queue-latency'
  gpu: TimingStats
  samples: number[]
  lifetime: TimingStats
  /** Lifetime 0.1 ms buckets, with the last bucket collecting >= 1000 ms. */
  histogram: number[]
  frameInterval: number
  adapter: { vendor: string; architecture: string; device: string; description: string } | null
}

interface CreateOptions {
  canvas: HTMLCanvasElement
  video: HTMLVideoElement
  options: UpscaleOptions
  onState?: (state: UpscaleDiagnostics) => void
  onDowngrade?: (tier: 'performance' | 'off') => void
  onFailure?: (reason: 'device-lost' | 'render-error') => void
}

interface Stage {
  name: string
  pipeline: GpuPipeline
  target: GpuTexture
  size: OutputSize
  uniform: GpuBuffer | null
  sources: GpuTexture[]
  external?: boolean
}

interface TimerSlot { query: GpuQuerySet; resolve: GpuBuffer; read: GpuBuffer; pending: boolean }

export async function probeWebGpu(): Promise<boolean> {
  try { return Boolean(await gpuEntry()?.requestAdapter({ powerPreference: 'high-performance' })) } catch { return false }
}

const EASU_WGSL = LOAD_WGSL + FSR_WGSL + /* wgsl */ `
@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return vec4f(easu(floor(position.xy)), 1.0);
}
`
const RCAS_WGSL = LOAD_WGSL + FSR_WGSL + /* wgsl */ `
@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return vec4f(rcas(vec2i(position.xy)), 1.0);
}
`

function stats(samples: readonly number[]): TimingStats {
  if (!samples.length) return { count: 0, p50: 0, p95: 0, max: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  return { count: sorted.length, p50: sorted[Math.floor((sorted.length - 1) * 0.5)]!, p95: sorted[Math.floor((sorted.length - 1) * 0.95)]!, max: sorted.at(-1)! }
}

/** Owns only presentation resources, never the commentary element or recognition frames. */
export class CameraUpscaler {
  private options: UpscaleOptions
  private readonly device: GpuDevice
  private readonly context: GpuContext
  private readonly format: string
  private readonly sampler: object
  private readonly pipelines = new Map<string, GpuPipeline>()
  private stages: Stage[] = []
  private textures: GpuTexture[] = []
  private timers: TimerSlot[] = []
  private controller: DegradeController
  private disposed = false
  private initialized = false
  private failed = false
  private dirty = true
  private callback = 0
  private usesVideoCallback = false
  private frames = 0
  private frameInterval = 1000 / 60
  private previousMediaTime: number | null = null
  private previousPresented = 0
  private published = 0
  private samples: number[] = []
  private histogram = new Array<number>(10001).fill(0)
  private measured = 0
  private maximum = 0
  private adapter: UpscaleDiagnostics['adapter']
  private readonly timing: UpscaleDiagnostics['timing']
  private readonly pausedFrame = (): void => { if (this.config.video.paused) this.frame(performance.now()) }

  private constructor(private readonly config: CreateOptions, device: GpuDevice, context: GpuContext, format: string, adapter: UpscaleDiagnostics['adapter']) {
    this.options = config.options
    this.device = device
    this.context = context
    this.format = format
    this.adapter = adapter
    this.controller = new DegradeController(this.options.tier)
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' })
    this.timing = device.features.has('timestamp-query') ? 'timestamp-query' : 'queue-latency'
    device.lost.then(({ reason }) => { if (!this.disposed && reason !== 'destroyed') this.fail('device-lost') }).catch(() => this.fail('device-lost'))
    device.addEventListener('uncapturederror', () => this.fail('render-error'))
    config.video.addEventListener('seeked', this.pausedFrame)
    config.video.addEventListener('loadeddata', this.pausedFrame)
    Object.defineProperties(config.canvas, {
      upscaleDiagnostics: { configurable: true, get: () => this.diagnostics() },
      readUpscalePixels: { configurable: true, value: () => this.readback() },
    })
  }

  static async create(config: CreateOptions): Promise<CameraUpscaler> {
    const gpu = gpuEntry()
    if (!gpu) throw new Error('WebGPU unavailable')
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('WebGPU adapter unavailable')
    const requiredFeatures = adapter.features.has('timestamp-query') ? ['timestamp-query'] : []
    const device = await adapter.requestDevice({ requiredFeatures })
    const context = config.canvas.getContext('webgpu') as unknown as GpuContext | null
    if (!context) { device.destroy(); throw new Error('WebGPU canvas unavailable') }
    const info = adapter.info
    const renderer = new CameraUpscaler(config, device, context, gpu.getPreferredCanvasFormat(), info
      ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : null)
    try {
      await renderer.initialize()
      renderer.initialized = true
      renderer.frame(performance.now())
      renderer.schedule()
      return renderer
    } catch (error) {
      renderer.dispose()
      throw error
    }
  }

  private async initialize(): Promise<void> {
    const sources = [
      { name: 'crop', wgsl: CROP_WGSL, format: 'rgba16float' },
      { name: 'bilinear', wgsl: BILINEAR_WGSL, format: this.format },
      { name: 'easu', wgsl: EASU_WGSL, format: 'rgba16float' },
      { name: 'rcas', wgsl: RCAS_WGSL, format: this.format },
      ...CNN_PASSES.map((pass) => ({ name: pass.name, wgsl: pass.wgsl, format: 'rgba16float' })),
    ]
    await Promise.all(sources.map(async ({ name, wgsl, format }) => {
      const module = this.device.createShaderModule({ label: `camera-${name}`, code: VERTEX_WGSL + wgsl })
      const pipeline = await this.device.createRenderPipelineAsync({
        label: `camera-${name}`, layout: 'auto',
        vertex: { module, entryPoint: 'vertexMain' },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      })
      this.pipelines.set(name, pipeline)
    }))
    if (this.timing === 'timestamp-query') {
      for (let i = 0; i < 3; i++) this.timers.push({
        query: this.device.createQuerySet({ type: 'timestamp', count: 2 }),
        resolve: this.device.createBuffer({ size: 16, usage: bufferUsage.QUERY_RESOLVE | bufferUsage.COPY_SRC }),
        read: this.device.createBuffer({ size: 16, usage: bufferUsage.MAP_READ | bufferUsage.COPY_DST }),
        pending: false,
      })
    }
  }

  update(options: UpscaleOptions): void {
    if (options.tier !== this.options.tier) this.controller = new DegradeController(options.tier)
    this.options = options
    this.dirty = true
    if (this.config.video.paused) this.frame(performance.now())
  }

  private releaseStages(): void {
    for (const stage of this.stages) stage.uniform?.destroy()
    for (const texture of this.textures) texture.destroy()
    this.stages = []
    this.textures = []
  }

  private prepare(): void {
    this.releaseStages()
    const { options } = this
    const crop = { width: Math.max(1, Math.round(options.crop.width)), height: Math.max(1, Math.round(options.crop.height)) }
    const output = outputSize(options.cssWidth, options.cssHeight, options.dpr)
    const plan = passPlan(this.controller.tier, crop, output)
    this.config.canvas.width = output.width
    this.config.canvas.height = output.height
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque', usage: textureUsage.RENDER_ATTACHMENT | textureUsage.COPY_DST })
    const add = (name: string, size: OutputSize, sources: GpuTexture[], uniform = true, external = false): GpuTexture => {
      const final = name === 'bilinear' || name === 'rcas'
      const target = this.device.createTexture({ label: `camera-${name}`, size, format: final ? this.format : 'rgba16float', usage: textureUsage.RENDER_ATTACHMENT | textureUsage.TEXTURE_BINDING | textureUsage.COPY_SRC })
      this.textures.push(target)
      const buffer = uniform ? this.device.createBuffer({ size: 48, usage: bufferUsage.UNIFORM | bufferUsage.COPY_DST }) : null
      const pipeline = this.pipelines.get(name)
      if (!pipeline) throw new Error(`Missing camera pipeline: ${name}`)
      this.stages.push({ name, pipeline, target, size, sources, uniform: buffer, external })
      return target
    }
    const original = add('crop', crop, [], true, true)
    let source = original
    let sourceSize = crop
    if (plan.passes.includes('cnn')) {
      const features: GpuTexture[] = []
      for (const cnn of CNN_PASSES) {
        const size = { width: crop.width * cnn.scale, height: crop.height * cnn.scale }
        source = add(cnn.name, size, cnn.inputs.map((index) => index < 0 ? original : features[index]!), false)
        features.push(source)
        sourceSize = size
      }
    }
    if (plan.passes.includes('easu')) {
      source = add('easu', output, [source])
      add('rcas', output, [source])
    } else add('bilinear', output, [source])
    for (const stage of this.stages) {
      if (!stage.uniform) continue
      const inputSize = stage.name === 'crop' ? { width: this.config.video.videoWidth, height: this.config.video.videoHeight }
        : stage.name === 'rcas' ? output : sourceSize
      this.device.queue.writeBuffer(stage.uniform, 0, new Float32Array([
        options.crop.width, options.crop.height, stage.size.width, stage.size.height,
        inputSize.width, inputSize.height, options.crop.x, options.crop.y,
        this.config.video.videoWidth, this.config.video.videoHeight,
      ]))
    }
    this.dirty = false
  }

  private schedule(): void {
    if (this.disposed || this.failed || this.controller.tier === 'off') return
    const video = this.config.video
    this.usesVideoCallback = typeof video.requestVideoFrameCallback === 'function'
    if (this.usesVideoCallback) this.callback = video.requestVideoFrameCallback((now, metadata) => {
      if (this.previousMediaTime !== null) {
        const interval = (metadata.mediaTime - this.previousMediaTime) * 1000 / Math.max(1, metadata.presentedFrames - this.previousPresented)
        if (interval > 4 && interval < 250) this.frameInterval = interval
      }
      this.previousMediaTime = metadata.mediaTime
      this.previousPresented = metadata.presentedFrames
      this.frame(now)
      this.schedule()
    })
    else this.callback = requestAnimationFrame((now) => { this.frame(now); this.schedule() })
  }

  private frame(now: number): void {
    if (this.disposed || !this.initialized || this.failed || this.controller.tier === 'off' || this.config.video.readyState < 2 || !this.config.video.videoWidth) return
    try {
      if (this.dirty) this.prepare()
      const encoder = this.device.createCommandEncoder()
      const timer = this.timers.find((slot) => !slot.pending)
      const started = performance.now()
      const external = this.device.importExternalTexture({ source: this.config.video })
      this.stages.forEach((stage, index) => {
        const entries: Descriptor[] = stage.uniform ? [{ binding: 0, resource: { buffer: stage.uniform } }] : []
        if (stage.external) entries.push({ binding: 1, resource: external }, { binding: 2, resource: this.sampler })
        else stage.sources.forEach((texture, textureIndex) => entries.push({ binding: textureIndex + 1, resource: texture.createView() }))
        const timestampWrites = timer ? { querySet: timer.query,
          ...(index === 0 ? { beginningOfPassWriteIndex: 0 } : {}),
          ...(index === this.stages.length - 1 ? { endOfPassWriteIndex: 1 } : {}),
        } : undefined
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: stage.target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          ...(timestampWrites && (index === 0 || index === this.stages.length - 1) ? { timestampWrites } : {}),
        })
        pass.setPipeline(stage.pipeline)
        pass.setBindGroup(0, this.device.createBindGroup({ layout: stage.pipeline.getBindGroupLayout(0), entries }))
        pass.draw(3)
        pass.end()
      })
      const final = this.stages.at(-1)!
      encoder.copyTextureToTexture({ texture: final.target }, { texture: this.context.getCurrentTexture() }, final.size as unknown as Descriptor)
      if (timer) {
        timer.pending = true
        encoder.resolveQuerySet(timer.query, 0, 2, timer.resolve, 0)
        encoder.copyBufferToBuffer(timer.resolve, 0, timer.read, 0, 16)
      }
      this.device.queue.submit([encoder.finish()])
      this.frames++
      if (timer) void timer.read.mapAsync(1).then(() => {
        const times = new BigUint64Array(timer.read.getMappedRange())
        const duration = Number(times[1]! - times[0]!) / 1e6
        timer.read.unmap()
        timer.pending = false
        this.record(duration)
      }).catch(() => { timer.pending = false })
      else if (this.timing === 'queue-latency') void this.device.queue.onSubmittedWorkDone().then(() => this.record(performance.now() - started)).catch(() => {})
      if (this.frames === 1 || now - this.published >= 1000) { this.published = now; this.config.onState?.(this.diagnostics()) }
    } catch { this.fail('render-error') }
  }

  private record(milliseconds: number): void {
    if (this.disposed || this.failed || !Number.isFinite(milliseconds) || milliseconds < 0) return
    this.samples.push(milliseconds)
    if (this.samples.length > 600) this.samples.shift()
    this.measured++
    this.maximum = Math.max(this.maximum, milliseconds)
    const bucket = Math.min(10000, Math.floor(milliseconds * 10))
    this.histogram[bucket] = (this.histogram[bucket] ?? 0) + 1
    const downgrade = this.controller.observe(milliseconds, this.frameInterval)
    if (downgrade === 'performance' || downgrade === 'off') {
      this.dirty = true
      this.config.onState?.(this.diagnostics())
      this.config.onDowngrade?.(downgrade)
    }
  }

  diagnostics(): UpscaleDiagnostics {
    const percentile = (ratio: number): number => {
      let count = 0
      for (let i = 0; i < this.histogram.length; i++) {
        count += this.histogram[i]!
        if (count > (this.measured - 1) * ratio) return (i + 0.5) / 10
      }
      return 0
    }
    return {
      tier: this.controller.tier, passes: this.stages.map((stage) => stage.name),
      width: this.config.canvas.width, height: this.config.canvas.height, frames: this.frames,
      timing: this.timing, gpu: stats(this.samples), samples: [...this.samples],
      lifetime: { count: this.measured, p50: this.measured ? percentile(0.5) : 0, p95: this.measured ? percentile(0.95) : 0, max: this.maximum },
      histogram: [...this.histogram], frameInterval: this.frameInterval, adapter: this.adapter ? { ...this.adapter } : null,
    }
  }

  async readback(): Promise<{ width: number; height: number; pixels: number[] }> {
    const stage = this.stages.at(-1)
    if (this.disposed || !stage) throw new Error('Camera output unavailable')
    const { width, height } = stage.size
    const bytesPerRow = Math.ceil(width * 4 / 256) * 256
    const buffer = this.device.createBuffer({ size: bytesPerRow * height, usage: bufferUsage.COPY_DST | bufferUsage.MAP_READ })
    try {
      const encoder = this.device.createCommandEncoder()
      encoder.copyTextureToBuffer({ texture: stage.target }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height })
      this.device.queue.submit([encoder.finish()])
      await buffer.mapAsync(1)
      const mapped = new Uint8Array(buffer.getMappedRange())
      const pixels = new Uint8Array(width * height * 4)
      for (let y = 0; y < height; y++) pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4)
      if (this.format.startsWith('bgra')) for (let i = 0; i < pixels.length; i += 4) { const red = pixels[i]!; pixels[i] = pixels[i + 2]!; pixels[i + 2] = red }
      buffer.unmap()
      return { width, height, pixels: Array.from(pixels) }
    } finally { buffer.destroy() }
  }

  private fail(reason: 'device-lost' | 'render-error'): void {
    if (this.disposed || this.failed) return
    this.failed = true
    this.config.onFailure?.(reason)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.usesVideoCallback) this.config.video.cancelVideoFrameCallback(this.callback)
    else cancelAnimationFrame(this.callback)
    this.config.video.removeEventListener('seeked', this.pausedFrame)
    this.config.video.removeEventListener('loadeddata', this.pausedFrame)
    this.releaseStages()
    for (const timer of this.timers) { timer.read.destroy(); timer.resolve.destroy(); timer.query.destroy() }
    this.timers = []
    this.context.unconfigure()
    this.device.destroy()
  }
}
