import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIQUIPEDIA_INTERVAL_MS, LiquipediaRateLimit, PARSE_INTERVAL_MS } from './liquipediaRateLimit'

const run = promisify(execFile)
describe('durable Liquipedia request quotas', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'fy1sync-lp-limit-')); vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000) })
  afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) })

  it('shares the two-second HTTP quota between parse, query and a second limiter', async () => {
    const first = new LiquipediaRateLimit(root), second = new LiquipediaRateLimit(root)
    expect(first.reserve(true)).toBe(true)
    expect(second.reserve()).toBe(false)
    expect(second.delay()).toBe(LIQUIPEDIA_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(LIQUIPEDIA_INTERVAL_MS - 1)
    expect(second.reserve()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(second.reserve()).toBe(true)
    expect(first.reserve()).toBe(false)
    expect(first.reserve(true)).toBe(false)
    expect(first.delay(true)).toBe(PARSE_INTERVAL_MS - LIQUIPEDIA_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(PARSE_INTERVAL_MS - LIQUIPEDIA_INTERVAL_MS)
    expect(first.reserve(true)).toBe(true)
    const state = JSON.parse(await readFile(join(root, 'events', 'liquipedia-http-attempt.json'), 'utf8'))
    expect(state).toEqual({ at: Date.now(), parseAt: Date.now() })
  })

  it('preserves the legacy persisted parse quota when migrating', async () => {
    const first = new LiquipediaRateLimit(root)
    expect(first.reserve()).toBe(true)
    await writeFile(join(root, 'events', 'liquipedia-attempt.json'), JSON.stringify({ at: Date.now() - 5_000 }))
    await vi.advanceTimersByTimeAsync(LIQUIPEDIA_INTERVAL_MS)
    const restarted = new LiquipediaRateLimit(root)
    expect(restarted.reserve(true)).toBe(false)
    expect(restarted.delay(true)).toBe(23_000)
    expect(restarted.reserve()).toBe(true)
  })

  it.each(['liquipedia-http-attempt.json', 'liquipedia-attempt.json'])('fails closed on corrupt %s', async name => {
    const limiter = new LiquipediaRateLimit(root)
    expect(limiter.reserve(true)).toBe(true)
    await writeFile(join(root, 'events', name), '{broken')
    await vi.advanceTimersByTimeAsync(PARSE_INTERVAL_MS)
    expect(limiter.reserve()).toBe(false)
    expect(limiter.reserve(true)).toBe(false)
    expect(limiter.delay()).toBe(LIQUIPEDIA_INTERVAL_MS)
  })

  it('does not bypass either quota when the wall clock moves backwards', () => {
    const limiter = new LiquipediaRateLimit(root)
    expect(limiter.reserve(true)).toBe(true)
    vi.setSystemTime(Date.now() - 60_000)
    expect(limiter.reserve()).toBe(false)
    expect(limiter.reserve(true)).toBe(false)
    expect(limiter.delay()).toBe(62_000)
    expect(limiter.delay(true)).toBe(90_000)
  })

  it('waits until the shared quota is available and can abort without consuming it', async () => {
    const limiter = new LiquipediaRateLimit(root), signal = new AbortController()
    expect(limiter.reserve()).toBe(true)
    let completed = false
    const pending = limiter.wait(signal.signal).then(() => { completed = true })
    await vi.advanceTimersByTimeAsync(LIQUIPEDIA_INTERVAL_MS - 1)
    expect(completed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(completed).toBe(true)
    const aborted = new AbortController(), reason = new Error('stopped')
    const waiting = limiter.wait(aborted.signal)
    const rejected = expect(waiting).rejects.toBe(reason)
    aborted.abort(reason)
    await rejected
    await vi.advanceTimersByTimeAsync(LIQUIPEDIA_INTERVAL_MS)
    expect(limiter.reserve()).toBe(true)
  })

  it('does not steal a live process mutex', async () => {
    const limiter = new LiquipediaRateLimit(root)
    expect(limiter.reserve()).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    await writeFile(join(root, 'events', 'liquipedia.lock'), JSON.stringify({ pid: process.pid }))
    expect(limiter.reserve()).toBe(false)
  })

  it('serializes reservations made by independent Node processes', async () => {
    vi.useRealTimers()
    const module = new URL('./liquipediaRateLimit.ts', import.meta.url).href
    const code = `import { LiquipediaRateLimit } from ${JSON.stringify(module)}; process.stdout.write(String(new LiquipediaRateLimit(process.argv[1], () => 1800000000000).reserve(true)))`
    const results = await Promise.all([1, 2].map(() => run(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', code, root])))
    expect(results.map(result => result.stdout).sort()).toEqual(['false', 'true'])
    expect(new LiquipediaRateLimit(root, () => 1_800_000_000_000).reserve()).toBe(false)
  })
})
