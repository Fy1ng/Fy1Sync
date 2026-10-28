/** The small WebGPU surface used here; lib.dom does not yet ship these declarations. */
export type Descriptor = Record<string, unknown>
export interface GpuBuffer {
  mapAsync(mode: number): Promise<void>
  getMappedRange(): ArrayBuffer
  unmap(): void
  destroy(): void
}
export interface GpuTexture {
  createView(): object
  destroy(): void
}
export interface GpuPipeline { getBindGroupLayout(index: number): object }
export interface GpuPass {
  setPipeline(pipeline: GpuPipeline): void
  setBindGroup(index: number, group: object): void
  draw(vertices: number): void
  end(): void
}
export interface GpuQuerySet { destroy(): void }
export interface GpuEncoder {
  beginRenderPass(descriptor: Descriptor): GpuPass
  resolveQuerySet(query: GpuQuerySet, first: number, count: number, destination: GpuBuffer, offset: number): void
  copyBufferToBuffer(source: GpuBuffer, sourceOffset: number, destination: GpuBuffer, destinationOffset: number, size: number): void
  copyTextureToTexture(source: Descriptor, destination: Descriptor, size: Descriptor): void
  copyTextureToBuffer(source: Descriptor, destination: Descriptor, size: Descriptor): void
  finish(): object
}
export interface GpuDevice {
  features: { has(name: string): boolean }
  lost: Promise<{ reason: string; message: string }>
  queue: { writeBuffer(buffer: GpuBuffer, offset: number, data: ArrayBufferView): void; submit(commands: object[]): void; onSubmittedWorkDone(): Promise<void> }
  createBuffer(descriptor: Descriptor): GpuBuffer
  createTexture(descriptor: Descriptor): GpuTexture
  createSampler(descriptor: Descriptor): object
  createShaderModule(descriptor: Descriptor): object
  createRenderPipelineAsync(descriptor: Descriptor): Promise<GpuPipeline>
  createBindGroup(descriptor: Descriptor): object
  createCommandEncoder(): GpuEncoder
  createQuerySet(descriptor: Descriptor): GpuQuerySet
  importExternalTexture(descriptor: { source: HTMLVideoElement }): object
  addEventListener(name: string, listener: (event: { error: { message: string } }) => void): void
  destroy(): void
}
export interface GpuAdapter {
  features: { has(name: string): boolean }
  info?: { vendor: string; architecture: string; device: string; description: string }
  requestDevice(descriptor: Descriptor): Promise<GpuDevice>
}
export interface GpuEntry {
  requestAdapter(options?: Descriptor): Promise<GpuAdapter | null>
  getPreferredCanvasFormat(): string
}
export interface GpuContext {
  configure(descriptor: Descriptor): void
  unconfigure(): void
  getCurrentTexture(): GpuTexture
}
export function gpuEntry(): GpuEntry | undefined {
  return (navigator as Navigator & { gpu?: GpuEntry }).gpu
}

export const textureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 }
export const bufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, QUERY_RESOLVE: 512 }
