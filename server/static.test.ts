import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  contentTypeFor,
  parseRange,
  resolveStaticPath,
  sendMissingClient,
  serveStatic,
} from './static'
import { asServerResponse, fakeResponse } from './testDoubles'

describe('contentTypeFor', () => {
  it('maps the extensions the built client actually emits', () => {
    expect(contentTypeFor('/assets/index-a1b2c3d4.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('/assets/index-a1b2c3d4.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/worker-x.mjs')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('/test-sources/countdown.mp4')).toBe('video/mp4')
    expect(contentTypeFor('/test-sources/stream.m3u8')).toBe('application/vnd.apple.mpegurl')
  })

  it('falls back to octet-stream for unknown and extensionless paths', () => {
    expect(contentTypeFor('/data.bin')).toBe('application/octet-stream')
    expect(contentTypeFor('/admin')).toBe('application/octet-stream')
  })

  it('ignores extension case', () => {
    expect(contentTypeFor('/LOGO.PNG')).toBe('image/png')
  })

  it('uses the last dot, so a versioned name is not mistaken for its middle segment', () => {
    expect(contentTypeFor('/vendor.min.css')).toBe('text/css; charset=utf-8')
  })
})

describe('resolveStaticPath', () => {
  const root = resolve('/srv/client')

  it('resolves a normal asset under the root', () => {
    expect(resolveStaticPath(root, '/assets/app.js')).toBe(join(root, 'assets', 'app.js'))
  })

  it('resolves the root itself', () => {
    expect(resolveStaticPath(root, '/')).toBe(root)
  })

  it('never escapes the root, however the traversal is spelled', () => {
    // `normalize` collapses leading `..` against an absolute path, so these do not become
    // null — they become harmless in-root paths that simply will not exist. Containment is
    // the property that matters, so that is what is asserted.
    for (const path of [
      '/../secret',
      '/assets/../../secret',
      '/%2e%2e/secret',
      '/..%2fsecret',
      '/%2e%2e%2f%2e%2e%2fetc/passwd',
      '/....//....//etc/passwd',
      '/assets/..%5c..%5csecret',
    ]) {
      const resolved = resolveStaticPath(root, path)
      if (resolved === null) continue
      expect(resolved === root || resolved.startsWith(root + sep)).toBe(true)
    }
  })

  it('rejects a NUL byte, which would truncate the path in a syscall', () => {
    expect(resolveStaticPath(root, '/app.js\0.txt')).toBeNull()
  })

  it('rejects a malformed percent escape rather than throwing', () => {
    expect(resolveStaticPath(root, '/%E0%A4%A')).toBeNull()
    expect(resolveStaticPath(root, '/%zz')).toBeNull()
  })

  it('does not accept a sibling directory that merely shares the root prefix', () => {
    // `/srv/client-secret` starts with `/srv/client` as a string but is not inside it, which
    // is why containment is checked against `root + sep` and not a bare `startsWith`.
    const resolved = resolveStaticPath(root, '/../client-secret/keys.json')
    expect(resolved).not.toBe(`${root}-secret${sep}keys.json`)
    if (resolved !== null) expect(resolved.startsWith(root + sep)).toBe(true)
  })

  it('rejects a relative path that climbs out of the root', () => {
    // A URL pathname always starts with `/`, which makes `normalize` clamp `..` at the
    // root — so the containment check is only reachable by a caller passing a relative
    // path. It still has to hold: this is the guard that would catch a future caller that
    // forwards something other than `url.pathname`.
    expect(resolveStaticPath(root, '../secret')).toBeNull()
    expect(resolveStaticPath(root, 'assets/../../secret')).toBeNull()
  })

  it('keeps an inner path that contains dots in a file name', () => {
    expect(resolveStaticPath(root, '/assets/app.min.js')).toBe(join(root, 'assets', 'app.min.js'))
  })

  it('normalises redundant separators without escaping', () => {
    expect(resolveStaticPath(root, '//assets///app.js')).toBe(join(root, 'assets', 'app.js'))
  })

  it('contains the resolved path inside the root', () => {
    const inside = resolveStaticPath(root, '/deep/nested/file.txt')
    expect(inside).not.toBeNull()
    expect(inside!.startsWith(root + sep)).toBe(true)
  })
})

describe('parseRange', () => {
  it('reads a closed range', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=200-299', 1000)).toEqual({ start: 200, end: 299 })
  })

  it('reads an open-ended range to the last byte, which is how a seek asks for the rest', () => {
    expect(parseRange('bytes=100-', 1000)).toEqual({ start: 100, end: 999 })
  })

  it('reads a suffix range, which is how a player finds an MP4 trailing moov atom', () => {
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 })
  })

  it('clamps a suffix longer than the file instead of reading before byte 0', () => {
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('clamps an end past the last byte, which browsers send routinely', () => {
    expect(parseRange('bytes=500-4000', 1000)).toEqual({ start: 500, end: 999 })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseRange('  bytes=0-9  ', 1000)).toEqual({ start: 0, end: 9 })
  })

  it('serves the whole file when there is no range to honour', () => {
    for (const header of [undefined, '', 'bytes=', 'bytes=-', 'items=0-10', 'bytes=abc-def']) {
      expect(parseRange(header, 1000)).toBeNull()
    }
  })

  it('declines a multi-range request rather than answering it wrongly', () => {
    // A correct answer is a multipart/byteranges body, which no media element asks for.
    // Sending the whole file is a legal answer and keeps the client working.
    expect(parseRange('bytes=0-10,20-30', 1000)).toBeNull()
    expect(parseRange('bytes=0-10, 20-30', 1000)).toBeNull()
  })

  it('declines a backwards range', () => {
    expect(parseRange('bytes=500-100', 1000)).toBeNull()
  })

  it('reports a range that starts past the end as unsatisfiable, not as a full body', () => {
    // 416 tells the client the file is smaller than it thought; a 200 makes it look like the
    // file silently changed under it.
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=1500-1600', 1000)).toBe('unsatisfiable')
  })

  it('has no satisfiable range in an empty file', () => {
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
    expect(parseRange('bytes=-10', 0)).toBe('unsatisfiable')
  })

  it('declines a zero-length suffix instead of failing the request', () => {
    expect(parseRange('bytes=-0', 1000)).toBeNull()
  })
})

function fakeRequest(url: string, headers: Record<string, string> = {}, method = 'GET'): IncomingMessage {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:5178', ...headers },
  } as unknown as IncomingMessage
}

describe('serveStatic', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'stream-sync-static-'))
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'index.html'), '<!doctype html><div id="root"></div>', 'utf8')
    await writeFile(join(root, 'assets', 'index-a1b2c3d4.js'), 'export const x = 1\n', 'utf8')
    await writeFile(join(root, 'assets', 'plain.js'), 'var y = 2\n', 'utf8')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('serves an existing asset with its content type and length', async () => {
    const res = fakeResponse()
    const handled = await serveStatic(fakeRequest('/assets/index-a1b2c3d4.js'), asServerResponse(res), { root })
    expect(handled).toBe(true)
    expect(res.status).toBe(200)
    expect(res.sentHeaders['content-type']).toBe('text/javascript; charset=utf-8')
    expect(res.body()).toBe('export const x = 1\n')
  })

  it('caches a content-hashed asset immutably', async () => {
    const res = fakeResponse()
    await serveStatic(fakeRequest('/assets/index-a1b2c3d4.js'), asServerResponse(res), { root })
    expect(res.sentHeaders['cache-control']).toBe('public, max-age=31536000, immutable')
  })

  it('refuses to cache an asset without a content hash', async () => {
    // Without a hash in the name the file can change under the same URL, so a year-long
    // cache would pin a stale copy.
    const res = fakeResponse()
    await serveStatic(fakeRequest('/assets/plain.js'), asServerResponse(res), { root })
    expect(res.sentHeaders['cache-control']).toBe('no-cache')
  })

  it('never hard-caches the HTML shell', async () => {
    const res = fakeResponse()
    await serveStatic(fakeRequest('/index.html'), asServerResponse(res), { root })
    expect(res.sentHeaders['cache-control']).toBe('no-cache')
  })

  it('falls back to the shell for a client route so /admin survives a reload', async () => {
    const res = fakeResponse()
    const handled = await serveStatic(fakeRequest('/admin'), asServerResponse(res), { root })
    expect(handled).toBe(true)
    expect(res.status).toBe(200)
    expect(res.sentHeaders['content-type']).toBe('text/html; charset=utf-8')
    expect(res.body()).toContain('id="root"')
  })

  it('declines a missing asset instead of answering it with HTML', async () => {
    // A bad import that receives the shell fails with a confusing MIME error in the
    // browser; a 404 says what actually happened.
    const res = fakeResponse()
    expect(await serveStatic(fakeRequest('/assets/gone-deadbeef.js'), asServerResponse(res), { root })).toBe(false)
    expect(res.headersSent).toBe(false)
  })

  it('falls back for a missing .html path, which is still a document request', async () => {
    const res = fakeResponse()
    expect(await serveStatic(fakeRequest('/some/page.html'), asServerResponse(res), { root })).toBe(true)
    expect(res.body()).toContain('id="root"')
  })

  it('serves a directory index when one exists', async () => {
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'index.html'), '<p>docs</p>', 'utf8')
    const res = fakeResponse()
    expect(await serveStatic(fakeRequest('/docs'), asServerResponse(res), { root })).toBe(true)
    expect(res.body()).toBe('<p>docs</p>')
  })

  it('falls back for a directory without an index rather than listing it', async () => {
    const res = fakeResponse()
    expect(await serveStatic(fakeRequest('/assets'), asServerResponse(res), { root })).toBe(true)
    expect(res.body()).toContain('id="root"')
  })

  it('answers 304 when the client already has the current etag', async () => {
    const first = fakeResponse()
    await serveStatic(fakeRequest('/assets/index-a1b2c3d4.js'), asServerResponse(first), { root })
    const etag = String(first.sentHeaders.etag)
    expect(etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f.]+"$/)

    const second = fakeResponse()
    await serveStatic(fakeRequest('/assets/index-a1b2c3d4.js', { 'if-none-match': etag }), asServerResponse(second), { root })
    expect(second.status).toBe(304)
    expect(second.body()).toBe('')
  })

  it('sends the body again when the etag no longer matches', async () => {
    const res = fakeResponse()
    await serveStatic(fakeRequest('/assets/index-a1b2c3d4.js', { 'if-none-match': 'W/"stale"' }), asServerResponse(res), { root })
    expect(res.status).toBe(200)
    expect(res.body()).toBe('export const x = 1\n')
  })

  it('changes the etag when the file changes', async () => {
    const before = fakeResponse()
    await serveStatic(fakeRequest('/assets/plain.js'), asServerResponse(before), { root })
    await writeFile(join(root, 'assets', 'plain.js'), 'var y = 3 // longer\n', 'utf8')
    const after = fakeResponse()
    await serveStatic(fakeRequest('/assets/plain.js'), asServerResponse(after), { root })
    expect(after.sentHeaders.etag).not.toBe(before.sentHeaders.etag)
  })

  it('answers HEAD with headers and no body', async () => {
    const info = await stat(join(root, 'assets', 'index-a1b2c3d4.js'))
    const res = fakeResponse()
    expect(await serveStatic(fakeRequest('/assets/index-a1b2c3d4.js', {}, 'HEAD'), asServerResponse(res), { root })).toBe(true)
    expect(res.status).toBe(200)
    expect(res.sentHeaders['content-length']).toBe(info.size)
    expect(res.body()).toBe('')
  })

  describe('range requests', () => {
    // 260 distinct bytes, so a slice can be checked against its exact expected text rather
    // than only by length — an off-by-one in the stream bounds shows up as wrong content.
    const media = Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i).repeat(10)).join('')

    beforeEach(async () => {
      await writeFile(join(root, 'clip.mp4'), media, 'utf8')
    })

    it('answers a range with 206 and just those bytes', async () => {
      // This is what makes seeking work: a `<video>` told to jump to t=40 asks for the bytes
      // around that point, and a server that replies 200 with everything makes it buffer from
      // the start to get there. Rewinding is this tool's core operation.
      const res = fakeResponse()
      expect(await serveStatic(fakeRequest('/clip.mp4', { range: 'bytes=10-19' }), asServerResponse(res), { root })).toBe(true)
      expect(res.status).toBe(206)
      expect(res.sentHeaders['content-range']).toBe(`bytes 10-19/${media.length}`)
      expect(res.sentHeaders['content-length']).toBe(10)
      expect(res.sentHeaders['content-type']).toBe('video/mp4')
      expect(res.body()).toBe('bbbbbbbbbb')
    })

    it('serves an open-ended range through to the last byte', async () => {
      const res = fakeResponse()
      await serveStatic(fakeRequest('/clip.mp4', { range: 'bytes=250-' }), asServerResponse(res), { root })
      expect(res.status).toBe(206)
      expect(res.sentHeaders['content-range']).toBe(`bytes 250-259/${media.length}`)
      expect(res.body()).toBe('zzzzzzzzzz')
    })

    it('serves a suffix range from the end of the file', async () => {
      const res = fakeResponse()
      await serveStatic(fakeRequest('/clip.mp4', { range: 'bytes=-20' }), asServerResponse(res), { root })
      expect(res.status).toBe(206)
      expect(res.sentHeaders['content-range']).toBe(`bytes 240-259/${media.length}`)
      expect(res.body()).toBe('yyyyyyyyyyzzzzzzzzzz')
    })

    it('advertises range support on a plain response, before any range is asked for', async () => {
      // A player only learns it may seek from the first response it gets.
      const res = fakeResponse()
      await serveStatic(fakeRequest('/clip.mp4'), asServerResponse(res), { root })
      expect(res.status).toBe(200)
      expect(res.sentHeaders['accept-ranges']).toBe('bytes')
      expect(res.sentHeaders['content-range']).toBeUndefined()
      expect(res.body()).toBe(media)
    })

    it('rejects a range past the end with 416 and the real size', async () => {
      const res = fakeResponse()
      expect(await serveStatic(fakeRequest('/clip.mp4', { range: 'bytes=9000-' }), asServerResponse(res), { root })).toBe(true)
      expect(res.status).toBe(416)
      expect(res.sentHeaders['content-range']).toBe(`bytes */${media.length}`)
      expect(res.body()).toBe('')
    })

    it('falls back to the whole file for a range it will not split', async () => {
      for (const range of ['bytes=abc-def', 'bytes=0-10,20-30', 'chunks=0-10']) {
        const res = fakeResponse()
        await serveStatic(fakeRequest('/clip.mp4', { range }), asServerResponse(res), { root })
        expect(res.status).toBe(200)
        expect(res.body()).toBe(media)
      }
    })

    it('ignores a range guarded by a weak validator', async () => {
      // The etag here is weak, so it cannot prove the client holds this exact file. RFC 9110
      // says send the whole thing rather than risk stitching two versions together.
      const probe = fakeResponse()
      await serveStatic(fakeRequest('/clip.mp4'), asServerResponse(probe), { root })
      const res = fakeResponse()
      await serveStatic(
        fakeRequest('/clip.mp4', { range: 'bytes=10-19', 'if-range': String(probe.sentHeaders.etag) }),
        asServerResponse(res),
        { root },
      )
      expect(res.status).toBe(200)
      expect(res.body()).toBe(media)
    })

    it('answers a HEAD range with the partial headers and no body', async () => {
      const res = fakeResponse()
      await serveStatic(fakeRequest('/clip.mp4', { range: 'bytes=0-9' }, 'HEAD'), asServerResponse(res), { root })
      expect(res.status).toBe(206)
      expect(res.sentHeaders['content-range']).toBe(`bytes 0-9/${media.length}`)
      expect(res.body()).toBe('')
    })

    it('still prefers 304 over a range when the client has the file already', async () => {
      const probe = fakeResponse()
      await serveStatic(fakeRequest('/clip.mp4'), asServerResponse(probe), { root })
      const res = fakeResponse()
      await serveStatic(
        fakeRequest('/clip.mp4', { range: 'bytes=10-19', 'if-none-match': String(probe.sentHeaders.etag) }),
        asServerResponse(res),
        { root },
      )
      expect(res.status).toBe(304)
      expect(res.body()).toBe('')
    })
  })

  it('declines any method other than GET or HEAD', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const res = fakeResponse()
      expect(await serveStatic(fakeRequest('/index.html', {}, method), asServerResponse(res), { root })).toBe(false)
      expect(res.headersSent).toBe(false)
    }
  })

  it('never serves a file from outside the root for a traversal attempt', async () => {
    const outside = join(root, '..', 'stream-sync-outside-secret.txt')
    await writeFile(outside, 'TOP SECRET', 'utf8')
    try {
      for (const path of [
        '/../stream-sync-outside-secret.txt',
        '/assets/../../stream-sync-outside-secret.txt',
        '/%2e%2e/stream-sync-outside-secret.txt',
      ]) {
        const res = fakeResponse()
        await serveStatic(fakeRequest(path), asServerResponse(res), { root })
        expect(res.body()).not.toContain('TOP SECRET')
      }
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('ignores the query string when locating a file', async () => {
    const res = fakeResponse()
    expect(await serveStatic(fakeRequest('/assets/index-a1b2c3d4.js?v=2'), asServerResponse(res), { root })).toBe(true)
    expect(res.body()).toBe('export const x = 1\n')
  })

  it('uses a custom SPA fallback when asked', async () => {
    await writeFile(join(root, 'shell.html'), '<p>shell</p>', 'utf8')
    const res = fakeResponse()
    await serveStatic(fakeRequest('/anything'), asServerResponse(res), { root, spaFallback: 'shell.html' })
    expect(res.body()).toBe('<p>shell</p>')
  })

  it('declines everything when the shell is missing, so the caller can explain why', async () => {
    await rm(join(root, 'index.html'))
    const res = fakeResponse()
    expect(await serveStatic(fakeRequest('/admin'), asServerResponse(res), { root })).toBe(false)
    expect(res.headersSent).toBe(false)
  })

  it('declines when the root directory does not exist at all', async () => {
    const res = fakeResponse()
    expect(await serveStatic(fakeRequest('/admin'), asServerResponse(res), { root: join(root, 'missing') })).toBe(false)
  })
})

describe('sendMissingClient', () => {
  it('explains how to build instead of returning a blank 404', async () => {
    const res = fakeResponse()
    sendMissingClient(asServerResponse(res), '/srv/app/dist/client')
    expect(res.status).toBe(503)
    const body = res.body()
    expect(body).toContain('/srv/app/dist/client')
    expect(body).toContain('npm run build')
    expect(body).toContain('npm run dev')
  })
})
