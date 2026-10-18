/**
 * Test doubles for the Node HTTP types, shared by the server suites.
 *
 * Deliberately not typed as `ServerResponse & {...}`: the properties a test needs to
 * observe (`headersSent`, `writableEnded`, `destroyed`) are read-only getters on the
 * real class, so an intersection cannot be assigned to and TypeScript reduces it to
 * `never`. The double declares its own writable shape and is cast exactly once, by
 * `asServerResponse`, at the boundary where production code receives it.
 */

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface FakeResponse extends EventEmitter {
  status: number
  sentHeaders: Record<string, unknown>
  headersSent: boolean
  writableEnded: boolean
  /** `stream.pipe(res)` checks this before writing. */
  writable: boolean
  /** Counts destroy() calls, which is what the client-hang-up tests assert on. */
  destroyCount: number
  body(): string
  /** Always returns true, so a body pipe never waits for a `drain` we never emit. */
  write(chunk: string | Uint8Array): boolean
  writeHead(status: number, headers?: Record<string, unknown>): FakeResponse
  end(chunk?: string | Uint8Array): FakeResponse
  setHeader(name: string, value: unknown): FakeResponse
  destroy(): FakeResponse
}

function lowerKeys(headers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
}

export function fakeResponse(): FakeResponse {
  const chunks: Buffer[] = []
  const res: FakeResponse = Object.assign(new EventEmitter(), {
    status: 0,
    sentHeaders: {} as Record<string, unknown>,
    headersSent: false,
    writableEnded: false,
    writable: true,
    destroyCount: 0,
    body: () => Buffer.concat(chunks).toString('utf8'),
    write(chunk: string | Uint8Array) {
      chunks.push(Buffer.from(chunk as Uint8Array))
      return true
    },
    writeHead(status: number, headers?: Record<string, unknown>) {
      res.status = status
      res.sentHeaders = lowerKeys(headers ?? {})
      res.headersSent = true
      return res
    },
    end(chunk?: string | Uint8Array) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk as Uint8Array))
      res.writableEnded = true
      // `pipeline` and `stream.pipe` both wait for this before resolving.
      res.emit('finish')
      return res
    },
    setHeader(name: string, value: unknown) {
      res.sentHeaders[name.toLowerCase()] = value
      return res
    },
    destroy() {
      res.destroyCount += 1
      res.writableEnded = true
      return res
    },
  })
  return res
}

/** The one place a double is passed off as the real thing. */
export function asServerResponse(res: FakeResponse): ServerResponse {
  return res as unknown as ServerResponse
}

export function fakeRequest(
  options: { url?: string; method?: string; headers?: Record<string, string> } = {},
): IncomingMessage {
  return {
    url: options.url ?? '/',
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
  } as unknown as IncomingMessage
}

/**
 * A decoded JSON body, shaped for assertions rather than for production use.
 *
 * `Response.json()` returns `unknown`, which is right for real callers — they have to
 * prove what came back before trusting it. A test already knows the contract it is
 * checking, and making it re-narrow at 20 call sites buries the assertion. This type
 * lets a test walk into a body freely; if the shape is wrong the expectation fails,
 * which is the outcome the test wanted anyway.
 */
export interface JsonBody {
  [key: string]: any
}

/** `await json(response)` instead of `(await response.json()) as SomeShape`. */
export async function json(response: Response): Promise<JsonBody> {
  return (await response.json()) as JsonBody
}
