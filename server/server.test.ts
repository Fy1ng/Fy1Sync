/**
 * Integration tests over a real `node:http` server on a real loopback socket.
 *
 * The unit suites cover each module's branches; this one covers the wiring — that routes
 * are mounted, that the guards run in the right order, and that the static handler and the
 * API do not shadow each other. Anything that only breaks once a socket is involved (SSE
 * framing, keep-alive, 404 vs SPA fallback) shows up here and nowhere else.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { packBitmap } from '../src/core/bitmapCodec'
import { createEmptyProfile, TEMPLATE_PIXELS } from '../src/core/profileSchema'
import { isPortUnavailable, startServer, type StartedServer } from './index'
import { json } from './testDoubles'

const ADMIN_TOKEN = 'test-admin-token'

function sampleData(seed = 0): string {
  const mask = new Uint8Array(TEMPLATE_PIXELS)
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = (index + seed) % 3 === 0 ? 255 : 0
  }
  return packBitmap(mask)
}

function validProfile(overrides: Record<string, unknown> = {}) {
  return {
    ...createEmptyProfile('cs2/iem', 'IEM Countdown'),
    templates: { '0': [{ id: 's0', data: sampleData(0), createdAt: 1, origin: 'editor' }] },
    ...overrides,
  }
}

describe('server integration', () => {
  let started: StartedServer
  let dataDir: string
  let clientDir: string
  let base: string

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'stream-sync-server-'))
    dataDir = join(root, 'data')
    clientDir = join(root, 'client')
    await mkdir(join(clientDir, 'assets'), { recursive: true })
    await writeFile(join(clientDir, 'index.html'), '<!doctype html><div id="root"></div>', 'utf8')
    await writeFile(join(clientDir, 'assets', 'app-a1b2c3d4.js'), 'export const app = 1\n', 'utf8')

    started = await startServer(
      {
        host: '127.0.0.1',
        // 0 lets the OS pick a free port, so a busy 5178 cannot make the suite flaky.
        port: 0,
        strictPort: true,
        clientDir,
        dataDir,
        adminToken: ADMIN_TOKEN,
      },
      {},
    )
    base = started.url
  })

  afterAll(async () => {
    await started.close()
    await rm(join(dataDir, '..'), { recursive: true, force: true })
  })

  afterEach(async () => {
    await rm(join(dataDir, 'presets'), { recursive: true, force: true })
  })

  /** Same-origin by default: the API rejects cross-site writes, as a browser page would be. */
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { origin: base, ...(init.headers as Record<string, string> | undefined) },
    })

  describe('health', () => {
    it('reports readiness and the live proxy setting', async () => {
      const response = await request('/api/health')
      expect(response.status).toBe(200)
      const body = await json(response)
      expect(body.ok).toBe(true)
      expect(body.version).toBe('0.1.0')
      expect(body.proxyEnabled).toBe(true)
      expect(body.danmakuRooms).toBe(0)
    })

    it('answers HEAD on a GET route', async () => {
      const response = await request('/api/health', { method: 'HEAD' })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('')
    })

    it('binds on the port it reports', async () => {
      expect(started.config.port).toBeGreaterThan(0)
      expect(base).toContain(String(started.config.port))
    })

    it('keeps SSE-friendly timeouts, so a danmaku stream is not culled at 5s', async () => {
      expect(started.server.keepAliveTimeout).toBe(65_000)
      expect(started.server.requestTimeout).toBe(0)
    })
  })

  describe('routing', () => {
    it('404s an unknown API path as JSON rather than serving the SPA shell', async () => {
      const response = await request('/api/nope')
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect((await json(response)).error.code).toBe('not-found')
    })

    it('404s a known path with the wrong method', async () => {
      const response = await request('/api/health', { method: 'DELETE' })
      expect(response.status).toBe(404)
    })

    it('serves the built client for the app route', async () => {
      const response = await request('/')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(await response.text()).toContain('id="root"')
    })

    it('serves the SPA shell for /admin so the editor survives a reload', async () => {
      const response = await request('/admin')
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('id="root"')
    })

    it('serves a hashed asset with an immutable cache header', async () => {
      const response = await request('/assets/app-a1b2c3d4.js')
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toContain('immutable')
    })

    it('404s a missing asset instead of handing back HTML', async () => {
      const response = await request('/assets/missing-deadbeef.js')
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toContain('application/json')
    })

    it('does not let a static path shadow the API namespace', async () => {
      await writeFile(join(clientDir, 'api'), 'should never be served', 'utf8')
      try {
        const response = await request('/api/health')
        expect((await json(response)).ok).toBe(true)
      } finally {
        await rm(join(clientDir, 'api'), { force: true })
      }
    })
  })

  describe('cross-origin protection', () => {
    it('rejects a cross-site write even though the service is loopback-bound', async () => {
      // Any page in the user's browser can reach 127.0.0.1; the origin check is what stops
      // a random site from driving this API.
      const response = await fetch(`${base}/api/admin/verify`, {
        method: 'POST',
        headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({ token: ADMIN_TOKEN }),
      })
      expect(response.status).toBe(403)
      expect((await json(response)).error.code).toBe('cross-origin')
    })

    it('allows a cross-origin read, which carries no side effect', async () => {
      const response = await fetch(`${base}/api/health`, {
        headers: { origin: 'https://evil.example.com' },
      })
      expect(response.status).toBe(200)
    })

    it('accepts a write with no origin header at all, as curl sends', async () => {
      const response = await fetch(`${base}/api/admin/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'wrong' }),
      })
      // 403 bad-token, not 403 cross-origin: it got past the origin gate.
      expect((await json(response)).error.code).toBe('bad-token')
    })
  })

  describe('admin verification', () => {
    it('accepts the configured token', async () => {
      const response = await request('/api/admin/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: ADMIN_TOKEN }),
      })
      expect(response.status).toBe(200)
      expect((await json(response)).ok).toBe(true)
    })

    it('rejects a wrong token without leaking its shape', async () => {
      for (const token of ['', 'wrong', `${ADMIN_TOKEN}x`, ADMIN_TOKEN.slice(0, -1)]) {
        const response = await request('/api/admin/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        expect(response.status).toBe(403)
        const body = await json(response)
        expect(body.error.code).toBe('bad-token')
        expect(body.error.message).not.toContain(ADMIN_TOKEN)
      }
    })

    it('rejects a malformed body', async () => {
      const response = await request('/api/admin/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      })
      expect(response.status).toBe(400)
    })

    it('rejects a non-string token', async () => {
      const response = await request('/api/admin/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: { toString: 'nope' } }),
      })
      expect(response.status).toBe(403)
    })
  })

  describe('resolve', () => {
    it('requires an input string', async () => {
      const response = await request('/api/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(response.status).toBe(400)
      expect((await json(response)).error.code).toBe('missing-input')
    })

    it('rejects a blank input', async () => {
      const response = await request('/api/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '   ' }),
      })
      expect(response.status).toBe(400)
    })

    it('resolves a direct URL without any network call', async () => {
      const response = await request('/api/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'https://example.com/stream.m3u8', platform: 'direct' }),
      })
      expect(response.status).toBe(200)
      const body = await json(response)
      expect(body.ok).toBe(true)
      expect(body.stream.kind).toBe('hls')
    })

    it('returns 200 with a structured failure for an unrecognised input', async () => {
      // A failed resolve is a normal outcome the UI explains, not an HTTP error.
      const response = await request('/api/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'not a url at all' }),
      })
      expect(response.status).toBe(200)
      const body = await json(response)
      expect(body.ok).toBe(false)
      expect(typeof body.failure.code).toBe('string')
      expect(typeof body.failure.message).toBe('string')
    })
  })

  describe('media proxy', () => {
    it('rejects a request with no target', async () => {
      const response = await request('/api/proxy')
      expect(response.status).toBe(400)
      expect((await json(response)).error.code).toBe('missing-url')
    })

    it('refuses a host outside the allow list', async () => {
      const response = await request(`/api/proxy?url=${encodeURIComponent('https://evil.example.com/a.ts')}`)
      expect(response.status).toBe(403)
      expect((await json(response)).error.code).toBe('host-not-allowed')
    })

    it('refuses a link-local metadata address', async () => {
      const response = await request(
        `/api/proxy?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`,
      )
      expect(response.status).toBe(403)
    })

    it('refuses a non-http scheme', async () => {
      const response = await request(`/api/proxy?url=${encodeURIComponent('file:///etc/passwd')}`)
      expect(response.status).toBe(403)
    })
  })

  describe('danmaku', () => {
    it('rejects a non-numeric room id', async () => {
      const response = await request('/api/danmaku/douyu/not-a-room')
      expect(response.status).toBe(400)
      expect((await json(response)).error.code).toBe('bad-room')
    })

    it('opens an SSE stream and sends the connection state first', async () => {
      const controller = new AbortController()
      try {
        const response = await request('/api/danmaku/douyu/288016', { signal: controller.signal })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        expect(response.headers.get('cache-control')).toContain('no-store')

        const reader = response.body!.getReader()
        const { value } = await reader.read()
        const chunk = new TextDecoder().decode(value)
        expect(chunk).toContain('event: state')
        expect(chunk).toContain('"room":"288016"')
        await reader.cancel()
      } finally {
        // Closing the request drops the subscriber, which releases the upstream socket.
        controller.abort()
      }
    })
  })

  describe('presets', () => {
    const adminHeaders = { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN }

    it('starts with an empty list', async () => {
      const response = await request('/api/presets')
      expect(response.status).toBe(200)
      expect((await json(response)).presets).toEqual([])
    })

    it('requires the admin token to write', async () => {
      const response = await request('/api/presets/cs2/iem', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validProfile()),
      })
      expect(response.status).toBe(403)
      expect((await json(response)).error.code).toBe('bad-token')
    })

    it('requires the admin token to delete', async () => {
      const response = await request('/api/presets/cs2/iem', { method: 'DELETE' })
      expect(response.status).toBe(403)
    })

    it('creates with 201 and an ETag, then updates with 200', async () => {
      const created = await request('/api/presets/cs2/iem', {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify(validProfile()),
      })
      expect(created.status).toBe(201)
      const etag = created.headers.get('etag')
      expect(etag).toMatch(/^"[0-9a-f]{32}"$/)

      const updated = await request('/api/presets/cs2/iem', {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify(validProfile({ name: 'IEM Rio' })),
      })
      expect(updated.status).toBe(200)
      expect(updated.headers.get('etag')).not.toBe(etag)
    })

    it('reads back a saved preset with a nested id', async () => {
      await request('/api/presets/cs2/iem', {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify(validProfile()),
      })
      const response = await request('/api/presets/cs2/iem')
      expect(response.status).toBe(200)
      const body = await json(response)
      expect(body.profile.id).toBe('cs2/iem')
      expect(body.profile.name).toBe('IEM Countdown')
      expect(response.headers.get('etag')).toBe(`"${body.etag}"`)
    })

    it('lists what was written, without the bitmap payloads', async () => {
      await request('/api/presets/cs2/iem', {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify(validProfile()),
      })
      const body = await json(await request('/api/presets'))
      expect(body.presets).toHaveLength(1)
      expect(body.presets[0]).toMatchObject({ id: 'cs2/iem', name: 'IEM Countdown', templateChars: 1 })
      // A list of full profiles would be megabytes of base64 the picker never renders.
      expect(JSON.stringify(body)).not.toContain(sampleData(0))
    })

    it('404s an unknown preset', async () => {
      const response = await request('/api/presets/cs2/does-not-exist')
      expect(response.status).toBe(404)
      expect((await json(response)).error.code).toBe('not-found')
    })

    it('422s an invalid profile with the failing paths attached', async () => {
      const response = await request('/api/presets/cs2/iem', {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify(validProfile({ matchThreshold: 5 })),
      })
      expect(response.status).toBe(422)
      const body = await json(response)
      expect(body.error.code).toBe('invalid-profile')
      expect(body.error.issues.some((issue: { path: string }) => issue.path === 'matchThreshold')).toBe(true)
    })

    it('409s a stale write and reports the current etag', async () => {
      const created = await request('/api/presets/cs2/iem', {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify(validProfile()),
      })
      const firstEtag = created.headers.get('etag')!

      await request('/api/presets/cs2/iem', {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify(validProfile({ name: 'Second' })),
      })

      const stale = await request('/api/presets/cs2/iem', {
        method: 'PUT',
        headers: { ...adminHeaders, 'if-match': firstEtag },
        body: JSON.stringify(validProfile({ name: 'Third' })),
      })
      expect(stale.status).toBe(409)
      const body = await json(stale)
      expect(body.error.code).toBe('conflict')
      expect(body.error.currentEtag).toMatch(/^[0-9a-f]{32}$/)

      const current = await json(await request('/api/presets/cs2/iem'))
      expect(current.profile.name).toBe('Second')
    })

    it('accepts a write whose if-match is current', async () => {
      const created = await request('/api/presets/cs2/iem', {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify(validProfile()),
      })
      const response = await request('/api/presets/cs2/iem', {
        method: 'PUT',
        headers: { ...adminHeaders, 'if-match': created.headers.get('etag')! },
        body: JSON.stringify(validProfile({ name: 'Renamed' })),
      })
      expect(response.status).toBe(200)
    })

    it('413s a body over the JSON limit', async () => {
      const response = await request('/api/presets/cs2/iem', {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify(validProfile({ notes: 'x'.repeat(2 * 1_048_576) })),
      })
      expect(response.status).toBe(413)
    })

    it('deletes once and then reports the preset gone', async () => {
      await request('/api/presets/cs2/iem', {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify(validProfile()),
      })
      const first = await request('/api/presets/cs2/iem', {
        method: 'DELETE',
        headers: { 'x-admin-token': ADMIN_TOKEN },
      })
      expect(first.status).toBe(200)
      const second = await request('/api/presets/cs2/iem', {
        method: 'DELETE',
        headers: { 'x-admin-token': ADMIN_TOKEN },
      })
      expect(second.status).toBe(404)
    })

    it('refuses an id that tries to climb out of the presets directory', async () => {
      const response = await request('/api/presets/..%2F..%2Fescaped', {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify(validProfile()),
      })
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).not.toBe(201)
    })
  })

  describe('error handling', () => {
    it('reports a handler failure as JSON without killing the server', async () => {
      // A body that is valid JSON but the wrong type reaches the store and is rejected;
      // the next request must still be served.
      const bad = await request('/api/presets/cs2/iem', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
        body: '[]',
      })
      expect(bad.status).toBeGreaterThanOrEqual(400)
      const health = await request('/api/health')
      expect(health.status).toBe(200)
    })

    it('survives an aborted request', async () => {
      const controller = new AbortController()
      const pending = request('/api/health', { signal: controller.signal }).catch(() => null)
      controller.abort()
      await pending
      expect((await request('/api/health')).status).toBe(200)
    })
  })
})

describe('startServer port handling', () => {
  const absentClient = join(tmpdir(), 'stream-sync-absent-client')

  it('reports the port the OS actually assigned, not the requested 0', async () => {
    const started = await startServer(
      { host: '127.0.0.1', port: 0, strictPort: true, clientDir: absentClient },
      {},
    )
    try {
      expect(started.config.port).toBeGreaterThan(0)
      expect(started.url).toBe(`http://127.0.0.1:${started.config.port}`)
      // The reported URL has to be openable, which is the point of reading it back.
      expect((await fetch(`${started.url}/api/health`)).status).toBe(200)
    } finally {
      await started.close()
    }
  })

  it('fails fast on a taken port when strictPort is set', async () => {
    const first = await startServer(
      { host: '127.0.0.1', port: 0, strictPort: true, clientDir: absentClient },
      {},
    )
    try {
      await expect(
        startServer(
          {
            host: '127.0.0.1',
            port: first.config.port,
            strictPort: true,
            clientDir: absentClient,
          },
          {},
        ),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' })
    } finally {
      await first.close()
    }
  })

  it('walks forward to a free port when strictPort is off', async () => {
    const first = await startServer(
      { host: '127.0.0.1', port: 0, strictPort: true, clientDir: absentClient },
      {},
    )
    let second: StartedServer | null = null
    try {
      second = await startServer(
        {
          host: '127.0.0.1',
          port: first.config.port,
          strictPort: false,
          clientDir: absentClient,
        },
        {},
      )
      expect(second.config.port).toBeGreaterThan(first.config.port)
      expect((await fetch(`${second.url}/api/health`)).status).toBe(200)
    } finally {
      await second?.close()
      await first.close()
    }
  })

  it('lands somewhere when the walk runs out of ports above the request', async () => {
    // 65535 leaves nowhere to walk to, which is the same dead end Windows produces with a
    // hundred-wide reserved block: the forward attempts are all spent and the server still
    // has to come up. Stepping past the top of the range would raise ERR_SOCKET_BAD_PORT.
    const first = await startServer(
      { host: '127.0.0.1', port: 65_535, strictPort: true, clientDir: absentClient },
      {},
    )
    let second: StartedServer | null = null
    try {
      second = await startServer(
        { host: '127.0.0.1', port: 65_535, strictPort: false, clientDir: absentClient },
        {},
      )
      expect(second.config.port).toBeGreaterThan(0)
      expect(second.config.port).not.toBe(65_535)
      expect((await fetch(`${second.url}/api/health`)).status).toBe(200)
    } finally {
      await second?.close()
      await first.close()
    }
  })

  describe('which errors are worth another port', () => {
    const error = (code: string): NodeJS.ErrnoException =>
      Object.assign(new Error(code), { code })

    it('walks past a busy port', () => {
      expect(isPortUnavailable(error('EADDRINUSE'), 5178)).toBe(true)
    })

    it('walks past a port Windows has reserved', () => {
      // Hyper-V reserves ranges and refuses them with EACCES rather than EADDRINUSE, so
      // treating that as fatal aborts the walk on the exact case it exists for.
      expect(isPortUnavailable(error('EACCES'), 5178)).toBe(true)
    })

    it('stops on a privileged port', () => {
      // Below 1024 an EACCES is a privilege problem, and the next 900 ports have it too.
      expect(isPortUnavailable(error('EACCES'), 80)).toBe(false)
    })

    it('stops on anything else', () => {
      expect(isPortUnavailable(error('EADDRNOTAVAIL'), 5178)).toBe(false)
      expect(isPortUnavailable(error('ERR_SOCKET_BAD_PORT'), 70_000)).toBe(false)
    })
  })

  it('explains how to build when the client directory is missing', async () => {
    const started = await startServer(
      {
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
        clientDir: join(tmpdir(), 'stream-sync-absent-client'),
      },
      {},
    )
    try {
      const response = await fetch(`${started.url}/`)
      expect(response.status).toBe(503)
      const body = await response.text()
      expect(body).toContain('npm run build')
      // The API still works without a built client, so the server is usable headless.
      expect((await fetch(`${started.url}/api/health`)).status).toBe(200)
    } finally {
      await started.close()
    }
  })
})
