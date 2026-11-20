import { request, type IncomingHttpHeaders } from 'node:http'

export function localRequest(port: number, path: string, method = 'GET', headers: Record<string, string> = {}):
Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}
