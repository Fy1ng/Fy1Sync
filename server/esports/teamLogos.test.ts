import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from './fixtures/liquipedia-matches.json'
import { parseSchedule } from './parser'
import { LOGO_FAILURE_TTL_MS, LOGO_MAX_BYTES, LOGO_TTL_MS, TeamLogoCache, normalizeLogoPath, readTeamLogo, teamLogoKey } from './teamLogos'
import { LIQUIPEDIA_INTERVAL_MS, LiquipediaRateLimit } from './liquipediaRateLimit'

const path = '/commons/images/thumb/a/ab/Team_darkmode.png/48px-Team_darkmode.png'
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
const jpg = Buffer.from([255, 216, 255, 0])
const webp = Buffer.from('RIFFxxxxWEBPtest')
const image = (bytes: Uint8Array = png, type = 'image/png', extra: Record<string, string> = {}) => new Response(new Uint8Array(bytes), { headers: { 'content-type': type, ...extra } })
const payload = (html: string) => ({ parse: { text: { '*': html } } })

describe('team logo parsing', () => {
  const parsed = (html = fixture.parse.text['*']) => { const paths = new Map<string, string>(); const matches = parseSchedule(payload(html), paths); return { matches, paths } }
  it('selects darkmode 2x only inside opponent team icons, excluding tournament icons', () => {
    const { matches, paths } = parsed()
    expect(paths.get(`${matches[0]!.id}:0`)).toBe('/commons/images/thumb/c/cd/G2_Esports_2019_darkmode.png/88px-G2_Esports_2019_darkmode.png')
    expect(paths.get(`${matches[0]!.id}:1`)).toContain('DENDELE_CS_allmode.png/76px-')
    expect([...paths.values()].some(value => value.includes('PGL_Masters'))).toBe(false)
    expect(matches.every(match => match.teams.every(team => team.logo === null))).toBe(true)
  })
  it('prefers allmode over lightmode and falls back to lightmode', () => {
    const dark = /<span class="team-template-image-icon team-template-darkmode">[\s\S]*?<\/span>/
    const all = fixture.parse.text['*'].replace(dark, value => value.replaceAll('darkmode', 'allmode'))
    expect([...parsed(all).paths.values()][0]).toContain('allmode')
    expect([...parsed(fixture.parse.text['*'].replace(dark, '')).paths.values()][0]).toContain('lightmode')
  })
  it('rejects tournament alt paths even when injected into a team icon', () => {
    const html = fixture.parse.text['*'].replaceAll('alt=""', 'alt="PGL/2026/Masters#Round 3"')
    expect(parsed(html).paths.size).toBe(0)
  })
  it('ignores invalid image paths and falls back from an invalid 2x to src', () => {
    const html = fixture.parse.text['*'].replaceAll('/commons/images/thumb/c/cd/G2_Esports_2019_darkmode.png/88px-G2_Esports_2019_darkmode.png', 'https://evil.invalid/a.png')
    expect([...parsed(html).paths.values()][0]).toContain('/44px-')
    expect(parsed(fixture.parse.text['*'].replaceAll('/commons/images/', 'https://evil.invalid/commons/images/')).paths.size).toBe(0)
  })
  it.each(['https://liquipedia.net/commons/images/a.png', '//liquipedia.net/commons/images/a.png', '/commons/images/../x',
    '/commons/images/%2e%2e/x', '/commons/images/%252e%252e/x', '/commons/images/a%2fb.png', '/commons/images/a\\b.png',
    '/commons/images/a.png?x', '/commons/images/a.png#x', '/commons/images/%00.png', '/commons/images/a//b', '/commons/images/%zz'])('rejects unsafe path %s', value => {
    expect(normalizeLogoPath(value)).toBeNull()
  })
})

describe('team logo disk and network cache', () => {
  let root: string, now: number
  const caches: TeamLogoCache[] = []
  function create(request: typeof fetch = vi.fn(async () => image())) {
    const cache = new TeamLogoCache({ userDataDir: root, version: '0.1.3', request, now: () => now, resolve: async () => ['93.184.216.34'] })
    caches.push(cache); return cache
  }
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'fy1sync-logos-')); now = Date.now() + 100 })
  afterEach(async () => { await Promise.all(caches.splice(0).map(cache => cache.dispose())); await rm(root, { recursive: true, force: true }) })
  it.each([[png, 'image/png', 'png'], [jpg, 'image/jpeg', 'jpg'], [webp, 'image/webp', 'webp']] as const)('persists %s with matching MIME and magic, reuses it across instances', async (bytes, type, ext) => {
    const request = vi.fn<typeof fetch>(async () => image(bytes, type)), cache = create(request)
    expect(cache.get(path)).toBeNull()
    expect(cache.get(path)).toBeNull()
    await cache.idle()
    const key = teamLogoKey(path)
    expect(cache.get(path)).toBe(`app://app/team-logo/${key}`)
    expect(await readFile(join(root, 'events', 'logos', `${key}.${ext}`))).toEqual(bytes)
    expect(create(request).get(path)).toBe(`app://app/team-logo/${key}`)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ 'User-Agent': 'Fy1Sync/0.1.3 (local desktop app; sync@fy1ng.cn)' })
  })
  it.each([
    () => image(png, 'image/svg+xml'), () => image(Buffer.from('<svg/>'), 'image/png'), () => image(jpg, 'image/png'),
    () => image(png, 'text/html'), () => image(png, 'image/png', { 'content-length': String(LOGO_MAX_BYTES + 1) }),
    () => image(Buffer.alloc(LOGO_MAX_BYTES + 1), 'image/png'), () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid/x' } }),
  ])('rejects unsupported MIME, spoofed signatures, oversize bodies and redirects %#', async makeResponse => {
    const request = vi.fn<typeof fetch>(async () => makeResponse()), cache = create(request)
    expect(cache.get(path)).toBeNull(); await cache.idle()
    expect(readTeamLogo(root, teamLogoKey(path), now)).toBeNull()
    cache.get(path); await cache.idle()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('persists a one-hour negative cache across restart and retries after expiry', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(image())
    const cache = create(request); cache.get(path); await cache.idle()
    const second = create(request); second.get(path); await second.idle()
    expect(request).toHaveBeenCalledTimes(1)
    now += LOGO_FAILURE_TTL_MS
    second.get(path); await second.idle()
    expect(request).toHaveBeenCalledTimes(2)
    expect(second.get(path)).toContain('app://app/team-logo/')
  })
  it('expires successful entries after seven days and rejects corrupt files', async () => {
    const request = vi.fn<typeof fetch>(async () => image()), cache = create(request)
    cache.get(path); await cache.idle()
    const file = join(root, 'events', 'logos', `${teamLogoKey(path)}.png`)
    await utimes(file, new Date(now - LOGO_TTL_MS), new Date(now - LOGO_TTL_MS))
    now += LIQUIPEDIA_INTERVAL_MS
    expect(cache.get(path)).toBeNull(); await cache.idle()
    expect(request).toHaveBeenCalledTimes(2)
    await writeFile(file, '<script>bad</script>')
    expect(readTeamLogo(root, teamLogoKey(path), now)).toBeNull()
  })
  it('normalizes submillisecond mtimes while rejecting future and expired images', async () => {
    const cache = create()
    cache.get(path); await cache.idle()
    const key = teamLogoKey(path), file = join(root, 'events', 'logos', `${key}.png`)
    const modifiedAt = (now + 0.75) / 1_000
    await utimes(file, modifiedAt, modifiedAt)
    expect((await stat(file)).mtimeMs).toBeGreaterThan(now)
    expect((await stat(file)).mtimeMs).toBeLessThan(now + 1)
    expect(readTeamLogo(root, key, now)?.bytes).toEqual(png)
    const future = (now + 1.75) / 1_000
    await utimes(file, future, future)
    expect(readTeamLogo(root, key, now)).toBeNull()
    const almostExpired = (now - LOGO_TTL_MS + 1.75) / 1_000
    await utimes(file, almostExpired, almostExpired)
    expect(readTeamLogo(root, key, now)?.bytes).toEqual(png)
    const expired = (now - LOGO_TTL_MS + 0.75) / 1_000
    await utimes(file, expired, expired)
    expect(readTeamLogo(root, key, now)).toBeNull()
  })
  it('downloads sequentially across cache instances with at least two seconds between starts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    let active = 0, peak = 0
    const starts: number[] = []
    const release: Array<() => void> = []
    const request = vi.fn<typeof fetch>(async () => { starts.push(now); active++; peak = Math.max(peak, active); await new Promise<void>(resolve => release.push(resolve)); active--; return image() })
    const first = create(request), second = create(request)
    try {
      for (let i = 0; i < 6; i++) (i % 2 ? first : second).get(path.replace('48px', `${48 + i}px`))
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(0)
        expect(release).toHaveLength(1)
        expect(request).toHaveBeenCalledTimes(i + 1)
        release.splice(0).forEach(resolve => resolve())
        await vi.advanceTimersByTimeAsync(0)
        now += LIQUIPEDIA_INTERVAL_MS - 1
        await vi.advanceTimersByTimeAsync(LIQUIPEDIA_INTERVAL_MS - 1)
        expect(request).toHaveBeenCalledTimes(i + 1)
        now++
        await vi.advanceTimersByTimeAsync(1)
      }
      await Promise.all([first.idle(), second.idle()])
      expect(peak).toBe(1)
      expect(starts.slice(1).map((at, index) => at - starts[index]!)).toEqual(Array(5).fill(LIQUIPEDIA_INTERVAL_MS))
    } finally { vi.useRealTimers() }
  })
  it('reads snapshots without scheduling downloads and notifies only after successful cache writes', async () => {
    const request = vi.fn<typeof fetch>(async () => image()), updated = vi.fn()
    const cache = new TeamLogoCache({ userDataDir: root, version: '0.1.3', request, now: () => now,
      resolve: async () => ['93.184.216.34'], onUpdated: updated })
    caches.push(cache)
    expect(cache.get(path, false)).toBeNull()
    await cache.idle()
    expect(request).not.toHaveBeenCalled()
    cache.get(path)
    await cache.idle()
    expect(updated).toHaveBeenCalledTimes(1)
    cache.get(path)
    await cache.idle()
    expect(updated).toHaveBeenCalledTimes(1)
  })
  it('shares the durable parse/query quota before a logo dispatch', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const rateLimit = new LiquipediaRateLimit(root, () => now)
    expect(rateLimit.reserve(true)).toBe(true)
    const request = vi.fn<typeof fetch>(async () => image()), cache = create(request)
    try {
      cache.get(path)
      await vi.advanceTimersByTimeAsync(0)
      expect(request).not.toHaveBeenCalled()
      now += LIQUIPEDIA_INTERVAL_MS
      await vi.advanceTimersByTimeAsync(LIQUIPEDIA_INTERVAL_MS)
      await cache.idle()
      expect(request).toHaveBeenCalledTimes(1)
      expect(rateLimit.reserve()).toBe(false)
      expect(rateLimit.reserve(true)).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it('returns immediately during an image download and exposes the completed cached image', async () => {
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    const images = create(vi.fn(async () => { await ready; return image() }))
    try {
      expect(images.get(path)).toBeNull()
      expect(images.get(path, false)).toBeNull()
      release()
      await images.idle()
      expect(images.get(path, false)).toContain('app://app/team-logo/')
    } finally { release() }
  })
})
