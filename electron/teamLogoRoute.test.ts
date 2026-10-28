import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CONTENT_SECURITY_POLICY } from './security'
import { teamLogoResponse } from './teamLogoRoute'

let root: string
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy1sync-logo-route-'))
  await mkdir(join(root, 'events', 'logos'), { recursive: true })
  await writeFile(join(root, 'events', 'logos', 'abc123.png'), bytes)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
it('serves only cached images with the existing CSP, MIME, nosniff and cache headers', async () => {
  const response = teamLogoResponse(new Request('app://app/team-logo/abc123'), root)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/png')
  expect(response.headers.get('cache-control')).toBe('max-age=604800')
  expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY)
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  expect(await teamLogoResponse(new Request('app://app/team-logo/abc123', { method: 'HEAD' }), root).text()).toBe('')
})
it.each(['missing', '../abc123', 'ABC123', 'abc123.png', '%61bc123', 'a'.repeat(65), 'abc123?x=1', 'abc123/extra'])('returns 404 for absent or invalid keys %s', key => {
  expect(teamLogoResponse(new Request(`app://app/team-logo/${key}`), root).status).toBe(404)
})
it('returns 404 for another origin, unsupported method or corrupted cache', async () => {
  expect(teamLogoResponse(new Request('app://evil/team-logo/abc123'), root).status).toBe(404)
  expect(teamLogoResponse(new Request('app://app/team-logo/abc123', { method: 'POST' }), root).status).toBe(404)
  await writeFile(join(root, 'events', 'logos', 'abc123.png'), '<svg/>')
  expect(teamLogoResponse(new Request('app://app/team-logo/abc123'), root).status).toBe(404)
})
