import { describe, expect, it, vi } from 'vitest'
import { MAX_PLATFORM_RESPONSE_BYTES, readPlatformBytes, readPlatformText } from './platformResponse'

const active = () => new AbortController().signal

describe('bounded platform metadata', () => {
  it('preserves non-UTF-8 WUP bytes while enforcing the same response limit', async () => {
    const bytes = new Uint8Array([0, 0xff, 0x80, 0x0d])
    expect(await readPlatformBytes(new Response(bytes), active())).toEqual(bytes)
    await expect(readPlatformBytes(new Response(new Uint8Array(MAX_PLATFORM_RESPONSE_BYTES + 1)), active())).rejects.toThrow('could not be read safely')
  })
  it('reads valid UTF-8 across chunk boundaries', async () => {
    const bytes = new TextEncoder().encode('斗鱼 metadata')
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 1))
      controller.enqueue(bytes.slice(1))
      controller.close()
    } }))
    expect(await readPlatformText(response, active())).toBe('斗鱼 metadata')
  })

  it.each([String(MAX_PLATFORM_RESPONSE_BYTES + 1), '-1', 'not-a-length'])('rejects an invalid advertised length %s before reading', async length => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': length } })
    await expect(readPlatformText(response, active())).rejects.toThrow('could not be read safely')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('counts actual bytes even if content-length understates a decompressed body', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(MAX_PLATFORM_RESPONSE_BYTES + 1))
    }, cancel }), { headers: { 'content-length': '1' } })
    await expect(readPlatformText(response, active())).rejects.toThrow('could not be read safely')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels a stalled body when its request deadline expires', async () => {
    const cancel = vi.fn()
    const controller = new AbortController()
    const response = new Response(new ReadableStream({ cancel }))
    const reading = readPlatformText(response, controller.signal)
    const assertion = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await assertion
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects malformed UTF-8 rather than passing replacement text to metadata parsers', async () => {
    await expect(readPlatformText(new Response(new Uint8Array([0xff])), active())).rejects.toThrow('could not be read safely')
  })

  it('cancels an already-aborted response without starting a read', async () => {
    const controller = new AbortController()
    controller.abort()
    const cancel = vi.fn()
    await expect(readPlatformText(new Response(new ReadableStream({ cancel })), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
