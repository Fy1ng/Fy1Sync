import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { browserCloser, normalizeWindowsPath, resolveBrowserProcessTarget } from './browserCloser'
import { BrowserImportError } from './browserImportError'
import type { DiscoveredBrowserProfile } from './browserProfiles'

function mockSpawn(handler: (stdin: string, child: EventEmitter & { kill: ReturnType<typeof vi.fn>; stdout: PassThrough; stderr: PassThrough; stdin: PassThrough }) => void) {
  return vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    })
    let input = ''
    child.stdin.on('data', chunk => { input += chunk.toString('utf8') })
    child.stdin.on('end', () => handler(input, child))
    return child as unknown as ChildProcess
  })
}

const edgeProfile: DiscoveredBrowserProfile = {
  id: 'e'.repeat(32),
  browser: 'edge',
  browserName: 'Microsoft Edge',
  name: '个人',
  isDefault: true,
  directory: 'C:\\Users\\Alice\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default',
  database: 'C:\\Users\\Alice\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Network\\Cookies',
  localState: 'C:\\Users\\Alice\\AppData\\Local\\Microsoft\\Edge\\User Data\\Local State',
}

describe('browser process target resolution', () => {
  it('maps Chromium channels and Firefox to isolated process targets', () => {
    expect(resolveBrowserProcessTarget(edgeProfile)).toEqual({
      imageName: 'msedge.exe',
      excludedPathFragments: ['\\microsoft\\edge beta\\', '\\microsoft\\edge dev\\', '\\microsoft\\edge sxs\\'],
      expectedUserDataDir: 'c:\\users\\alice\\appdata\\local\\microsoft\\edge\\user data',
    })
    expect(resolveBrowserProcessTarget({
      browser: 'edge',
      browserName: 'Microsoft Edge Beta',
      directory: 'C:\\Users\\Alice\\AppData\\Local\\Microsoft\\Edge Beta\\User Data\\Profile 1',
    })).toEqual({
      imageName: 'msedge.exe',
      requiredPathFragment: '\\microsoft\\edge beta\\',
      expectedUserDataDir: 'c:\\users\\alice\\appdata\\local\\microsoft\\edge beta\\user data',
    })
    expect(resolveBrowserProcessTarget({
      browser: 'chrome',
      browserName: 'Google Chrome Canary',
      directory: 'C:\\Users\\Alice\\AppData\\Local\\Google\\Chrome SxS\\User Data\\Default',
    })).toEqual({
      imageName: 'chrome.exe',
      requiredPathFragment: '\\google\\chrome sxs\\',
      expectedUserDataDir: 'c:\\users\\alice\\appdata\\local\\google\\chrome sxs\\user data',
    })
    expect(resolveBrowserProcessTarget({
      browser: 'firefox',
      browserName: 'Mozilla Firefox',
      directory: 'C:\\Users\\Alice\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\abc.default',
    })).toEqual({ imageName: 'firefox.exe' })
    expect(resolveBrowserProcessTarget({
      browser: 'chrome',
      browserName: 'Unknown Browser',
      directory: 'C:\\Temp\\Default',
    })).toBeNull()
    expect(normalizeWindowsPath(' "C:/Users/Alice/User Data/" ')).toBe('c:\\users\\alice\\user data')
  })
})

describe('browserCloser', () => {
  it('rejects unsupported platforms before spawning', async () => {
    const spawn = vi.fn()
    const close = browserCloser({ platform: 'linux', spawn })
    await expect(close(edgeProfile, new AbortController().signal)).rejects.toMatchObject({ code: 'browser-import-unsupported' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('sends target payload via stdin and verifies Chromium cookie unlock after closing', async () => {
    let payload: Record<string, unknown> | undefined
    const spawn = mockSpawn((stdin, child) => {
      payload = JSON.parse(stdin)
      child.stdout.end(JSON.stringify({ status: 'closed', initialCount: 4, remainingCount: 0 }))
      child.emit('close', 0)
    })
    const waitForUnlock = vi.fn(async () => {})
    const close = browserCloser({ platform: 'win32', spawn, waitForUnlock })
    const result = await close(edgeProfile, new AbortController().signal)
    expect(result).toEqual({ status: 'closed', browserName: 'Microsoft Edge' })
    expect(payload).toMatchObject({
      imageName: 'msedge.exe',
      requiredPathFragment: null,
      excludedPathFragments: ['\\microsoft\\edge beta\\', '\\microsoft\\edge dev\\', '\\microsoft\\edge sxs\\'],
      expectedUserDataDir: 'c:\\users\\alice\\appdata\\local\\microsoft\\edge\\user data',
    })
    expect(waitForUnlock).toHaveBeenCalledWith(edgeProfile.database, expect.any(AbortSignal))
  })

  it('skips unlock verification when the browser is not running or for Firefox', async () => {
    const waitForUnlock = vi.fn(async () => {})
    const notRunningSpawn = mockSpawn((_stdin, child) => {
      child.stdout.end(JSON.stringify({ status: 'not-running', initialCount: 0, remainingCount: 0 }))
      child.emit('close', 0)
    })
    expect(await browserCloser({ platform: 'win32', spawn: notRunningSpawn, waitForUnlock })(edgeProfile, new AbortController().signal))
      .toEqual({ status: 'not-running', browserName: 'Microsoft Edge' })
    expect(waitForUnlock).not.toHaveBeenCalled()

    const firefoxSpawn = mockSpawn((_stdin, child) => {
      child.stdout.end(JSON.stringify({ status: 'closed', initialCount: 1, remainingCount: 0 }))
      child.emit('close', 0)
    })
    const firefoxProfile: DiscoveredBrowserProfile = {
      id: 'f'.repeat(32), browser: 'firefox', browserName: 'Mozilla Firefox', name: 'default', isDefault: true,
      directory: 'C:\\Users\\Alice\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\default',
      database: 'C:\\Users\\Alice\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\default\\cookies.sqlite',
    }
    expect(await browserCloser({ platform: 'win32', spawn: firefoxSpawn, waitForUnlock })(firefoxProfile, new AbortController().signal))
      .toEqual({ status: 'closed', browserName: 'Mozilla Firefox' })
    expect(waitForUnlock).not.toHaveBeenCalled()
  })

  it('surfaces browser-import-close-failed when processes remain, script fails, or unlock fails', async () => {
    const remainingSpawn = mockSpawn((_stdin, child) => {
      child.stdout.end(JSON.stringify({ status: 'failed', initialCount: 2, remainingCount: 1 }))
      child.emit('close', 0)
    })
    await expect(browserCloser({ platform: 'win32', spawn: remainingSpawn, waitForUnlock: async () => {} })(edgeProfile, new AbortController().signal))
      .rejects.toMatchObject({ code: 'browser-import-close-failed' })

    const unlockFailSpawn = mockSpawn((_stdin, child) => {
      child.stdout.end(JSON.stringify({ status: 'closed', initialCount: 1, remainingCount: 0 }))
      child.emit('close', 0)
    })
    const failUnlock = vi.fn(async () => { throw new BrowserImportError('browser-import-close-failed') })
    await expect(browserCloser({ platform: 'win32', spawn: unlockFailSpawn, waitForUnlock: failUnlock })(edgeProfile, new AbortController().signal))
      .rejects.toMatchObject({ code: 'browser-import-close-failed' })
  })

  it('kills the helper process and rejects with cancellation when aborted', async () => {
    let killMock!: ReturnType<typeof vi.fn>
    const spawn = mockSpawn((_stdin, child) => { killMock = child.kill })
    const controller = new AbortController()
    const promise = browserCloser({ platform: 'win32', spawn, waitForUnlock: async () => {} })(edgeProfile, controller.signal)
    await vi.waitFor(() => expect(killMock).toBeTypeOf('function'))
    controller.abort()
    await expect(promise).rejects.toMatchObject({ code: 'browser-import-cancelled' })
    expect(killMock).toHaveBeenCalledOnce()
  })
})
