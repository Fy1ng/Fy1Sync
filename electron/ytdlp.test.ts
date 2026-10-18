import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { YtDlpRunner } from './ytdlp'

vi.mock('./toolLocator', async (actual) => ({ ...await actual<object>(), locateTool: vi.fn(async () => '/tools/yt-dlp.exe') }))
afterEach(() => vi.useRealTimers())

function harness() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() }) as unknown as ChildProcess
  const launch = vi.fn(() => child) as unknown as typeof spawn
  const cleanup = vi.fn()
  const cookies = { withTemporaryCookies: vi.fn(async (_platform, callback) => {
    try { return await callback('/private/copy.txt') } finally { cleanup() }
  }) }
  const killTree = vi.fn(async () => { child.emit('close', 1) })
  const runner = new YtDlpRunner({ electronPath: '/electron.exe', cookies, spawn: launch,
    env: { PATH: 'kept', EXAMPLE: 'unchanged' }, timeoutMs: 100, killTree })
  return { child, launch, cleanup, cookies, runner, killTree }
}

describe('isolated yt-dlp execution', () => {
  it('uses argument arrays, a temporary cookie path and child-only Electron Node mode', async () => {
    const h = harness()
    const inherited = process.env.ELECTRON_RUN_AS_NODE
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk')
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledOnce())
    const [executable, args, options] = vi.mocked(h.launch).mock.calls[0]!
    expect(executable).toBe('/tools/yt-dlp.exe')
    expect(args).toEqual(expect.arrayContaining(['-J', '--cookies', '/private/copy.txt', '--js-runtimes', 'node:/electron.exe', '--ignore-config', '--no-remote-components']))
    expect(options).toMatchObject({ shell: false, env: { ELECTRON_RUN_AS_NODE: '1', PATH: 'kept' } })
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe(inherited)
    h.child.stdout!.emit('data', Buffer.from('{"is_live":true}'))
    h.child.emit('close', 0)
    expect(await pending).toEqual({ is_live: true })
    expect(h.cleanup).toHaveBeenCalledOnce()
  })

  it('classifies authentication without exposing stderr or cookie values', async () => {
    const h = harness()
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk')
    const rejected = expect(pending).rejects.toThrow(/^YouTube sign in required$/)
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledOnce())
    h.child.stderr!.emit('data', Buffer.from('sign in required Cookie=PRIVATE https://secret.invalid/?token=PRIVATE'))
    h.child.emit('close', 1)
    await rejected
    expect(h.cleanup).toHaveBeenCalledOnce()
  })

  it('kills the whole runtime tree and finishes cookie cleanup during disposal', async () => {
    const h = harness()
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk')
    const rejected = expect(pending).rejects.toThrow('取消')
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledOnce())
    await h.runner.dispose()
    await rejected
    expect(h.killTree).toHaveBeenCalledWith(h.child)
    expect(h.cleanup).toHaveBeenCalledOnce()
  })
})
