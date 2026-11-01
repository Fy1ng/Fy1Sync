import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from './fixtures/liquipedia-matches.json'
import { parseSchedule } from './parser'
import { LOGO_REFRESH_MS, LOGO_REFRESH_STEP_MS, LOGO_RETRY_COOLDOWN_MS, LOGO_MAX_BYTES, TeamLogoCache, normalizeLogoPath, readTeamLogo, teamLogoKey } from './teamLogos'
import { LIQUIPEDIA_INTERVAL_MS, LiquipediaRateLimit } from './liquipediaRateLimit'

const path = '/commons/images/thumb/a/ab/Team_darkmode.png/48px-Team_darkmode.png'
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
const jpg = Buffer.from([255, 216, 255, 0])
const webp = Buffer.from('RIFFxxxxWEBPtest')
const image = (bytes: Uint8Array = png, type = 'image/png', extra: Record<string, string> = {}) => new Response(new Uint8Array(bytes), { headers: { 'content-type': type, ...extra } })
const payload = (html: string) => ({ parse: { text: { '*': html } } })
const version = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('team logo parsing', () => {
  const parsed = (html = fixture.parse.text['*']) => { const paths = new Map<string, string>(); const matches = parseSchedule(payload(html), paths); return { matches, paths } }
  /** Crest paths only; event icons are kept under their own `:event` keys. */
  const crests = (paths: Map<string, string>) => [...paths].filter(([key]) => !key.endsWith(':event')).map(([, value]) => value)
  it('selects darkmode 2x only inside opponent team icons, excluding tournament icons', () => {
    const { matches, paths } = parsed()
    expect(paths.get(`${matches[0]!.id}:0`)).toBe('/commons/images/thumb/c/cd/G2_Esports_2019_darkmode.png/88px-G2_Esports_2019_darkmode.png')
    expect(paths.get(`${matches[0]!.id}:1`)).toContain('DENDELE_CS_allmode.png/76px-')
    expect(crests(paths).some(value => value.includes('PGL_Masters'))).toBe(false)
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
    expect(crests(parsed(html).paths)).toHaveLength(0)
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
    expect(cache.get(path)).toBe(`app://app/team-logo/${key}?v=${version(bytes)}`)
    expect(await readFile(join(root, 'events', 'logos', `${key}.${ext}`))).toEqual(bytes)
    expect(create(request).get(path)).toBe(`app://app/team-logo/${key}?v=${version(bytes)}`)
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
  it('keeps entries older than seven days and rejects corrupt files', async () => {
    const request = vi.fn<typeof fetch>(async () => image()), cache = create(request)
    cache.get(path); await cache.idle()
    const file = join(root, 'events', 'logos', `${teamLogoKey(path)}.png`)
    await utimes(file, new Date(now - LOGO_REFRESH_MS * 10), new Date(now - LOGO_REFRESH_MS * 10))
    now += LIQUIPEDIA_INTERVAL_MS
    expect(cache.get(path)).toContain('?v='); await cache.idle()
    expect(request).toHaveBeenCalledTimes(1)
    await writeFile(file, '<script>bad</script>')
    expect(readTeamLogo(root, teamLogoKey(path), now)).toBeNull()
  })
  it('does not use image timestamps as an availability deadline', async () => {
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
    expect(readTeamLogo(root, key, now)?.bytes).toEqual(png)
    const almostExpired = (now - LOGO_REFRESH_MS + 1.75) / 1_000
    await utimes(file, almostExpired, almostExpired)
    expect(readTeamLogo(root, key, now)?.bytes).toEqual(png)
    const expired = (now - LOGO_REFRESH_MS + 0.75) / 1_000
    await utimes(file, expired, expired)
    expect(readTeamLogo(root, key, now)?.bytes).toEqual(png)
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

  it('retries transient errors with bounded backoff and persists a short cooldown across restart', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const starts: number[] = []
    const request = vi.fn<typeof fetch>(async () => { starts.push(now); throw new Error('offline') })
    const cache = create(request)
    try {
      cache.get(path)
      await vi.advanceTimersByTimeAsync(0)
      expect(request).toHaveBeenCalledTimes(1)
      now += 4_999; await vi.advanceTimersByTimeAsync(4_999)
      expect(request).toHaveBeenCalledTimes(1)
      now++; await vi.advanceTimersByTimeAsync(1)
      expect(request).toHaveBeenCalledTimes(2)
      now += 30_000; await vi.advanceTimersByTimeAsync(30_000); await cache.idle()
      expect(starts.map(at => at - starts[0]!)).toEqual([0, 5_000, 35_000])
      const second = create(request); second.get(path); await second.idle()
      expect(request).toHaveBeenCalledTimes(3)
      request.mockImplementation(async () => image())
      now += LOGO_RETRY_COOLDOWN_MS; await vi.advanceTimersByTimeAsync(LOGO_RETRY_COOLDOWN_MS)
      second.get(path); await vi.advanceTimersByTimeAsync(0); await second.idle()
      expect(request).toHaveBeenCalledTimes(4)
      expect(second.get(path)).toContain('?v=')
    } finally { vi.useRealTimers() }
  })

  it('checks active images gradually, persists equal-content checks without rewriting and survives restart', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const request = vi.fn<typeof fetch>(async () => image()), cache = create(request)
    const key = teamLogoKey(path), file = join(root, 'events', 'logos', `${key}.png`)
    try {
      cache.get(path); await vi.advanceTimersByTimeAsync(0); await cache.idle()
      await utimes(file, new Date(10_000), new Date(10_000))
      const before = (await stat(file)).mtimeMs
      now += LOGO_REFRESH_MS; await vi.advanceTimersByTimeAsync(LOGO_REFRESH_MS)
      cache.setActivePaths([path])
      now += LOGO_REFRESH_STEP_MS - 1; await vi.advanceTimersByTimeAsync(LOGO_REFRESH_STEP_MS - 1)
      expect(request).toHaveBeenCalledTimes(1)
      now++; await vi.advanceTimersByTimeAsync(1); await cache.idle()
      expect(request).toHaveBeenCalledTimes(2)
      expect((await stat(file)).mtimeMs).toBe(before)
      expect(JSON.parse(await readFile(join(root, 'events', 'logos', `${key}.checked.json`), 'utf8')).checkedAt).toBe(now)
      await cache.dispose()
      const second = create(request); second.setActivePaths([path])
      now += LOGO_REFRESH_STEP_MS; await vi.advanceTimersByTimeAsync(LOGO_REFRESH_STEP_MS); await second.idle()
      expect(request).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('replaces different content, changes the snapshot URL and notifies only for content changes', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const request = vi.fn<typeof fetch>(async () => image()), updated = vi.fn()
    const cache = new TeamLogoCache({ userDataDir: root, version: '0.1.3', request, now: () => now,
      resolve: async () => ['93.184.216.34'], onUpdated: updated })
    caches.push(cache)
    try {
      cache.get(path); await vi.advanceTimersByTimeAsync(0); await cache.idle()
      const old = cache.get(path), key = teamLogoKey(path)
      request.mockImplementation(async () => image(jpg, 'image/jpeg'))
      now += LOGO_REFRESH_MS; vi.setSystemTime(now); cache.setActivePaths([path])
      now += LOGO_REFRESH_STEP_MS; await vi.advanceTimersByTimeAsync(LOGO_REFRESH_STEP_MS); await cache.idle()
      expect(cache.get(path)).not.toBe(old)
      expect(readTeamLogo(root, key)?.bytes).toEqual(jpg)
      expect(updated).toHaveBeenCalledTimes(2)
      expect(await readFile(join(root, 'events', 'logos', `${key}.png`))).toEqual(png)
      now += LOGO_REFRESH_MS; vi.setSystemTime(now)
      now += LOGO_REFRESH_STEP_MS; await vi.advanceTimersByTimeAsync(LOGO_REFRESH_STEP_MS)
      await cache.idle()
      expect(updated).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('treats damaged check metadata as due and preserves the old image after validation failure', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const request = vi.fn<typeof fetch>(async () => image()), cache = create(request)
    try {
      cache.get(path); await vi.advanceTimersByTimeAsync(0); await cache.idle()
      const old = cache.get(path)
      await writeFile(join(root, 'events', 'logos', `${teamLogoKey(path)}.checked.json`), '{broken')
      request.mockImplementation(async () => image(Buffer.from('<svg/>'), 'image/png'))
      cache.setActivePaths([path])
      now += LOGO_REFRESH_STEP_MS; await vi.advanceTimersByTimeAsync(LOGO_REFRESH_STEP_MS); await cache.idle()
      expect(request).toHaveBeenCalledTimes(2)
      expect(cache.get(path)).toBe(old)
      now += LOGO_REFRESH_STEP_MS * 10; await vi.advanceTimersByTimeAsync(LOGO_REFRESH_STEP_MS * 10)
      expect(request).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('reads bundled images without writing the bundle and rejects mismatched, oversized and symlinked files', async () => {
    const bundle = join(root, 'bundle'), key = teamLogoKey(path), dir = join(bundle, 'events', 'logos')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${key}.png`)
    await writeFile(file, png)
    const request = vi.fn<typeof fetch>(async () => image())
    const cache = new TeamLogoCache({ userDataDir: root, bundledLogoDir: bundle, version: '0.1.3', request })
    caches.push(cache)
    expect(cache.get(path)).toBe(`app://app/team-logo/${key}?v=${version(png)}`)
    await cache.idle(); expect(request).not.toHaveBeenCalled()
    await writeFile(file, jpg)
    expect(readTeamLogo(root, key, now, bundle)).toBeNull()
    await writeFile(file, Buffer.concat([png, Buffer.alloc(LOGO_MAX_BYTES)]))
    expect(readTeamLogo(root, key, now, bundle)).toBeNull()
    const target = join(root, 'target.png'); await writeFile(target, png)
    const linkKey = teamLogoKey(path + 'link')
    try { await symlink(target, join(dir, `${linkKey}.png`)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; return }
    expect(readTeamLogo(root, linkKey, now, bundle)).toBeNull()
  })

  it('sends waiting crests by their current priority, and a slotted one steps aside before it reserves', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const sized = (px: number) => path.replace('48px', `${px}px`)
    const [first, early, late, urgent] = [sized(60), sized(61), sized(62), sized(63)]
    const sent: string[] = []
    const request = vi.fn<typeof fetch>(async input => { sent.push(new URL(String(input)).pathname); return image() })
    const cache = create(request), limiter = new LiquipediaRateLimit(root, () => now)
    try {
      expect(limiter.reserve(true)).toBe(true)
      cache.setPriorities([first, early, late, urgent])
      for (const value of [first, early, late]) cache.get(value)
      await vi.advanceTimersByTimeAsync(0)
      // `first` holds the only slot and waits for the quota. The viewer's focus changes:
      cache.setPriorities([urgent, late, early, first])
      cache.get(urgent)
      for (let step = 0; step < 4; step++) {
        now += LIQUIPEDIA_INTERVAL_MS; await vi.advanceTimersByTimeAsync(LIQUIPEDIA_INTERVAL_MS)
      }
      await cache.idle()
      expect(sent).toEqual([urgent, late, early, first])
      expect(request).toHaveBeenCalledTimes(4)
      expect(new Set(sent).size).toBe(4)
    } finally { vi.useRealTimers() }
  })
  it('spreads due refreshes and gives newly missing images priority while a refresh waits for quota', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const other = path.replace('48px', '50px'), fresh = path.replace('48px', '52px')
    const starts: Array<{ path: string; at: number }> = []
    const request = vi.fn<typeof fetch>(async input => { starts.push({ path: new URL(String(input)).pathname, at: now }); return image() })
    const cache = create(request), dir = join(root, 'events', 'logos')
    try {
      await mkdir(dir, { recursive: true })
      for (const value of [path, other]) await writeFile(join(dir, `${teamLogoKey(value)}.png`), png)
      const limiter = new LiquipediaRateLimit(root, () => now)
      cache.setActivePaths([path, other])
      now += LOGO_REFRESH_STEP_MS - 1; await vi.advanceTimersByTimeAsync(LOGO_REFRESH_STEP_MS - 1)
      expect(limiter.reserve(true)).toBe(true)
      now++; await vi.advanceTimersByTimeAsync(1)
      expect(request).not.toHaveBeenCalled()
      cache.get(fresh)
      await vi.advanceTimersByTimeAsync(0)
      now += 1_999; await vi.advanceTimersByTimeAsync(1_999)
      expect(starts[0]?.path).toBe(fresh)
      now += 2_000; await vi.advanceTimersByTimeAsync(2_000); await cache.idle()
      expect(starts.map(value => value.path)).toEqual([fresh, path])
      expect(starts[1]!.at - starts[0]!.at).toBeGreaterThanOrEqual(2_000)
      now += LOGO_REFRESH_STEP_MS; await vi.advanceTimersByTimeAsync(LOGO_REFRESH_STEP_MS); await cache.idle()
      expect(starts.map(value => value.path)).toEqual([fresh, path, other])
      cache.setActivePaths([])
      now += LOGO_REFRESH_MS; await vi.advanceTimersByTimeAsync(LOGO_REFRESH_MS)
      expect(request).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })

  it('starts the response timeout only after a long limiter wait', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const rateLimit = new LiquipediaRateLimit(root, () => now)
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      await new Promise<void>((yes, no) => {
        const timer = setTimeout(yes, 14_000)
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); no(init.signal?.reason) }, { once: true })
      })
      return image()
    })
    const cache = new TeamLogoCache({ userDataDir: root, version: '0.1.3', request, now: () => now,
      resolve: async () => ['93.184.216.34'], rateLimit })
    caches.push(cache)
    try {
      vi.spyOn(rateLimit, 'wait').mockImplementationOnce(async signal => { await new Promise<void>(yes => setTimeout(yes, 20_000)); signal.throwIfAborted() })
      cache.get(path); await vi.advanceTimersByTimeAsync(0)
      now += 20_000; await vi.advanceTimersByTimeAsync(20_000)
      expect(request).toHaveBeenCalledTimes(1)
      now += 14_000; await vi.advanceTimersByTimeAsync(14_000); await cache.idle()
      expect(cache.get(path)).toContain('?v=')
    } finally { vi.useRealTimers() }
  })

  it('times out stalled response bodies with bounded retries while preserving the old image', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const request = vi.fn<typeof fetch>(async () => image()), cache = create(request)
    try {
      cache.get(path); await vi.advanceTimersByTimeAsync(0); await cache.idle()
      const old = cache.get(path)
      request.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>(), { headers: { 'content-type': 'image/png' } }))
      now += LOGO_REFRESH_MS; vi.setSystemTime(now); cache.setActivePaths([path])
      now += LOGO_REFRESH_STEP_MS; await vi.advanceTimersByTimeAsync(LOGO_REFRESH_STEP_MS)
      expect(request).toHaveBeenCalledTimes(2)
      now += 15_000; await vi.advanceTimersByTimeAsync(15_000)
      expect(cache.get(path)).toBe(old)
      now += 5_000; await vi.advanceTimersByTimeAsync(5_000)
      expect(request).toHaveBeenCalledTimes(3)
      now += 15_000; await vi.advanceTimersByTimeAsync(15_000)
      now += 30_000; await vi.advanceTimersByTimeAsync(30_000)
      expect(request).toHaveBeenCalledTimes(4)
      now += 15_000; await vi.advanceTimersByTimeAsync(15_000); await cache.idle()
      expect(cache.get(path)).toBe(old)
      now += 60_000; await vi.advanceTimersByTimeAsync(60_000)
      expect(request).toHaveBeenCalledTimes(4)
    } finally { vi.useRealTimers() }
  })

  it('honors Retry-After without retrying validation failures', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '60' } }))
      .mockResolvedValueOnce(image())
    const cache = create(request)
    try {
      cache.get(path); await vi.advanceTimersByTimeAsync(0)
      now += 59_999; await vi.advanceTimersByTimeAsync(59_999)
      expect(request).toHaveBeenCalledTimes(1)
      now++; await vi.advanceTimersByTimeAsync(1); await cache.idle()
      expect(request).toHaveBeenCalledTimes(2)
      expect(cache.get(path)).toContain('?v=')
    } finally { vi.useRealTimers() }
  })
})
