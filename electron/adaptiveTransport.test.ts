import { EventEmitter } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adaptiveTransport } from './adaptiveTransport'

vi.mock('node:net', () => ({ createServer: vi.fn() }))
afterEach(() => { vi.clearAllMocks() })

class FakeSocket extends Writable {
  readonly chunks: Buffer[] = []
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }
}

function harness(deferListening = false) {
  const server = Object.assign(new EventEmitter(), {
    maxConnections: 0,
    listen: vi.fn((_name: string, callback: () => void) => { if (!deferListening) queueMicrotask(callback) }),
    close: vi.fn(),
  })
  let connect: (connection: Socket) => void = () => { throw new Error('not created') }
  vi.mocked(createServer).mockImplementation(((handler: (connection: Socket) => void) => {
    connect = handler
    return server as unknown as Server
  }) as typeof createServer)
  return { server, connect: (socket: FakeSocket) => { connect(socket as unknown as Socket) } }
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

describe('adaptive ffmpeg audio transport', () => {
  it('uses the existing extra pipe:3 descriptor on non-Windows without a server', async () => {
    const controller = new AbortController()
    const transport = await adaptiveTransport(controller.signal, 'linux')
    expect(transport).toMatchObject({ audioInput: 'pipe:3', extraPipe: true })
    expect(transport.audio).toBeUndefined()
    expect(createServer).not.toHaveBeenCalled()
    transport.close()
    controller.abort()
    expect(createServer).not.toHaveBeenCalled()
  })

  it('listens only on a random local Windows pipe path and allows one connection', async () => {
    const h = harness()
    const transport = await adaptiveTransport(new AbortController().signal, 'win32')
    expect(transport.extraPipe).toBe(false)
    expect(transport.audioInput).toMatch(/^\\\\\.\\pipe\\stream-syncer-[0-9a-f-]+$/)
    expect(h.server.listen).toHaveBeenCalledExactlyOnceWith(transport.audioInput, expect.any(Function))
    expect(h.server.maxConnections).toBe(1)
    const first = new FakeSocket(), second = new FakeSocket()
    h.connect(first)
    expect(h.server.close).toHaveBeenCalledOnce()
    h.connect(second)
    expect(second.destroyed).toBe(true)
    expect(first.destroyed).toBe(false)
    transport.close()
    expect(first.destroyed).toBe(true)
  })

  it('buffers audio before ffmpeg connects and preserves bytes across later writes', async () => {
    const h = harness()
    const transport = await adaptiveTransport(new AbortController().signal, 'win32')
    const expected = Buffer.from([0, 1, 2, 253, 254, 255, 8, 9])
    transport.audio!.write(expected.subarray(0, 3))
    transport.audio!.write(expected.subarray(3, 6))
    const socket = new FakeSocket()
    h.connect(socket)
    await flush()
    expect(Buffer.concat(socket.chunks)).toEqual(expected.subarray(0, 6))
    transport.audio!.write(expected.subarray(6))
    await flush()
    expect(Buffer.concat(socket.chunks)).toEqual(expected)
    transport.close()
  })

  it('backpressures the preconnection buffer and drains it in order after connection', async () => {
    const h = harness()
    const transport = await adaptiveTransport(new AbortController().signal, 'win32')
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 0xab)
    expect(transport.audio!.write(bytes)).toBe(false)
    const socket = new FakeSocket()
    h.connect(socket)
    await flush()
    expect(Buffer.concat(socket.chunks).equals(bytes)).toBe(true)
    expect(transport.audio!.writableNeedDrain).toBe(false)
    transport.close()
  })

  it('cancels and destroys the audio stream, accepted connection and pipe server', async () => {
    const h = harness()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const transport = await adaptiveTransport(controller.signal, 'win32')
    const socket = new FakeSocket()
    h.connect(socket)
    controller.abort()
    expect(transport.audio!.destroyed).toBe(true)
    expect(socket.destroyed).toBe(true)
    expect(h.server.close).toHaveBeenCalledTimes(2)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    transport.close()
    expect(h.server.close).toHaveBeenCalledTimes(2)
  })

  it('closes idempotently before a connection and rejects any late connection', async () => {
    const h = harness()
    const controller = new AbortController()
    const transport = await adaptiveTransport(controller.signal, 'win32')
    transport.close()
    transport.close()
    controller.abort()
    expect(transport.audio!.destroyed).toBe(true)
    expect(h.server.close).toHaveBeenCalledOnce()
    const late = new FakeSocket()
    h.connect(late)
    expect(late.destroyed).toBe(true)
    expect(h.server.close).toHaveBeenCalledOnce()
  })

  it('converts socket diagnostics into a fixed audio error', async () => {
    const h = harness()
    const transport = await adaptiveTransport(new AbortController().signal, 'win32')
    const errors: Error[] = []
    transport.audio!.on('error', error => { errors.push(error) })
    const socket = new FakeSocket()
    h.connect(socket)
    socket.emit('error', new Error('PRIVATE_SIGNED_URL'))
    await flush()
    expect(errors.map(error => error.message)).toEqual(['adaptive pipe failed'])
    expect(transport.audio!.destroyed).toBe(true)
    transport.close()
  })

  it('handles a late pipe server error after listening without an unhandled native exception', async () => {
    const h = harness()
    const transport = await adaptiveTransport(new AbortController().signal, 'win32')
    const errors: Error[] = []
    transport.audio!.on('error', error => { errors.push(error) })
    h.server.emit('error', new Error('PRIVATE_LOCAL_PATH'))
    await flush()
    expect(errors.map(error => error.message)).toEqual(['adaptive pipe failed'])
    transport.close()
  })

  it('notifies the producer when ffmpeg closes the accepted pipe unexpectedly', async () => {
    const h = harness()
    const transport = await adaptiveTransport(new AbortController().signal, 'win32')
    const errors: Error[] = []
    transport.audio!.on('error', error => { errors.push(error) })
    const socket = new FakeSocket()
    h.connect(socket)
    socket.destroy()
    await flush()
    expect(errors.map(error => error.message)).toEqual(['adaptive pipe closed'])
    transport.close()
  })

  it('cleans up a failed listen and hides native error details', async () => {
    const h = harness(true)
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = adaptiveTransport(controller.signal, 'win32').catch((error: unknown) => error)
    h.server.emit('error', new Error('PRIVATE_LOCAL_PATH'))
    const error = await pending
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toBe('Error: adaptive pipe unavailable')
    expect(h.server.close).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expect(h.server.close).toHaveBeenCalledOnce()
  })

  it('does not listen when the request is already cancelled', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort()
    await expect(adaptiveTransport(controller.signal, 'win32')).rejects.toThrow('adaptive pipe unavailable')
    expect(h.server.listen).not.toHaveBeenCalled()
    expect(h.server.close).toHaveBeenCalledOnce()
  })

  it('settles cancellation while the listen callback is still pending', async () => {
    const h = harness(true)
    const controller = new AbortController()
    let result: unknown = 'pending'
    const pending = adaptiveTransport(controller.signal, 'win32')
    void pending.then(value => { result = value }, error => { result = error })
    controller.abort()
    await flush()
    expect(result).toBeInstanceOf(Error)
    expect(String(result)).toBe('Error: adaptive pipe unavailable')
    expect(h.server.close).toHaveBeenCalledOnce()
    // A delayed native listen completion must not resurrect the cancelled transport.
    h.server.listen.mock.calls[0]![1]()
    await flush()
    expect(String(result)).toBe('Error: adaptive pipe unavailable')
  })
})
