import { test, expect } from './electron'

test('发送传输在实际 Electron Node worker 中收发二进制, 终止可关闭无回执连接', async ({ electronApp }) => {
  test.setTimeout(20_000)
  const result = await electronApp.evaluate(async () => {
    const { createServer } = process.getBuiltinModule('node:http') as typeof import('node:http')
    const { createHash } = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')
    type WireEvent = { data?: unknown }
    type LocalSocket = {
      readyState: number
      send(data: Uint8Array): void
      close(): void
      terminate(): Promise<unknown>
      addEventListener(type: string, listener: (event: WireEvent) => void): void
    }
    const main = globalThis as typeof globalThis & { __streamSyncerTest?: { createDouyuSocketFixture(url: string): LocalSocket } }
    const server = createServer((_request, response) => { response.writeHead(404).end() })
    const peers = new Set<import('node:stream').Duplex>()
    let client: LocalSocket | undefined
    let releasePeer!: () => void
    const peerClosed = new Promise<void>(resolve => { releasePeer = resolve })
    let releaseClientBytes!: (value: number[]) => void
    const clientBytes = new Promise<number[]>(resolve => { releaseClientBytes = resolve })
    const expected = [0, 1, 128, 255]
    server.on('upgrade', (request, peer) => {
      peers.add(peer)
      peer.on('error', () => {})
      // HTTP upgrade sockets allow a half-open TCP connection. Close the fixture's
      // own writable half after the client releases its connection.
      peer.on('end', () => { peer.end() })
      peer.on('close', () => { peers.delete(peer); releasePeer() })
      const key = request.headers['sec-websocket-key']
      if (typeof key !== 'string') { peer.destroy(); return }
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      peer.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      let buffer: Buffer = Buffer.alloc(0)
      peer.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 2) {
          const opcode = buffer[0]! & 15
          const length = buffer[1]! & 127
          const masked = (buffer[1]! & 128) !== 0
          if (length >= 126 || !masked) { peer.destroy(); return }
          if (buffer.length < 6 + length) return
          const body = buffer.subarray(6, 6 + length).map((value, index) => value ^ buffer[2 + index % 4]!)
          buffer = buffer.subarray(6 + length)
          if (opcode === 2) {
            releaseClientBytes([...body])
            peer.write(Buffer.from([0x82, expected.length, ...expected]))
          }
          // Deliberately withhold a close reply. Worker termination must release it.
        }
      })
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Local fixture address unavailable')
      client = main.__streamSyncerTest!.createDouyuSocketFixture(`ws://127.0.0.1:${address.port}/`)
      const received = new Promise<number[]>((resolve, reject) => {
        client!.addEventListener('open', () => { client!.send(Uint8Array.from(expected)) })
        client!.addEventListener('message', event => {
          if (!(event.data instanceof ArrayBuffer)) reject(new Error('Expected an ArrayBuffer'))
          else resolve([...new Uint8Array(event.data)])
        })
        client!.addEventListener('error', () => { reject(new Error('Local worker transport failed')) })
        timer = setTimeout(() => reject(new Error('Local worker fixture timed out')), 5_000)
      })
      const [incoming, outgoing] = await Promise.all([received, clientBytes])
      if (timer) clearTimeout(timer)
      client.close()
      await client.terminate()
      await Promise.race([peerClosed, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Terminated worker left a peer open')), 3_000)
      })])
      return { incoming, outgoing, readyState: client.readyState, peers: peers.size }
    } finally {
      if (timer) clearTimeout(timer)
      await client?.terminate()
      for (const peer of peers) peer.destroy()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  })
  expect(result).toEqual({ incoming: [0, 1, 128, 255], outgoing: [0, 1, 128, 255], readyState: 3, peers: 0 })
})
