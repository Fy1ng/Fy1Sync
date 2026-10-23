import { randomUUID } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { PassThrough, type Writable } from 'node:stream'

export interface AdaptiveTransport {
  audioInput: string
  extraPipe: boolean
  audio?: Writable
  close(): void
}

/** Windows ffmpeg cannot address Node's extra handles as CRT pipe:3 descriptors.
 * Use a single local named pipe there; no TCP socket or HTTP server is opened.
 * Buffering starts before ffmpeg opens its second input, avoiding a probe deadlock.
 */
export async function adaptiveTransport(signal: AbortSignal, platform = process.platform): Promise<AdaptiveTransport> {
  if (platform !== 'win32') return { audioInput: 'pipe:3', extraPipe: true, close() {} }
  const name = `\\\\.\\pipe\\stream-syncer-${randomUUID()}`
  const audio = new PassThrough({ highWaterMark: 8 * 1024 * 1024 })
  let socket: Socket | undefined
  let closed = false
  const server = createServer(connection => {
    if (closed || socket) { connection.destroy(); return }
    socket = connection
    server.close()
    connection.on('error', () => audio.destroy(new Error('adaptive pipe failed')))
    connection.on('close', () => { if (!closed) audio.destroy(new Error('adaptive pipe closed')) })
    audio.pipe(connection)
  })
  server.maxConnections = 1
  server.on('error', () => { if (!closed) audio.destroy(new Error('adaptive pipe failed')) })
  // Errors are consumed even when no puller has attached yet.
  audio.on('error', () => {})
  const close = () => {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', close)
    audio.destroy()
    socket?.destroy()
    server.close()
  }
  signal.addEventListener('abort', close, { once: true })
  try {
    if (signal.aborted) throw new Error('adaptive pipe cancelled')
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort)
        server.removeListener('error', onError)
      }
      const onError = () => { cleanup(); reject(new Error('adaptive pipe failed')) }
      const onAbort = () => { cleanup(); reject(new Error('adaptive pipe cancelled')) }
      signal.addEventListener('abort', onAbort, { once: true })
      server.once('error', onError)
      server.listen(name, () => { cleanup(); if (signal.aborted) server.close(); resolve() })
    })
    if (signal.aborted) throw new Error('adaptive pipe cancelled')
    return { audioInput: name, extraPipe: false, audio, close }
  } catch { close(); throw new Error('adaptive pipe unavailable') }
}
