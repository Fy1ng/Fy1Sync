import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findSystemBrowser, findSystemChrome, findSystemEdge, findSystemFirefox } from './login'

afterEach(() => vi.restoreAllMocks())

function installed(files: string[]) {
  return vi.spyOn(fs, 'statSync').mockImplementation(file => {
    if (!files.includes(String(file))) throw new Error('not installed')
    return { isFile: () => true } as ReturnType<typeof fs.statSync>
  })
}

describe('macOS Chrome discovery', () => {
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const userChrome = '/Users/fixture/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

  it('uses a per-user Applications installation when there is no system installation', () => {
    const stat = installed([userChrome])
    expect(findSystemChrome({ HOME: '/Users/fixture' }, 'darwin')).toBe(userChrome)
    expect(stat.mock.calls.map(([file]) => file)).toEqual([systemChrome, userChrome])
  })

  it('prefers the system application and does not search relative home paths', () => {
    const stat = installed([systemChrome, userChrome])
    expect(findSystemChrome({ HOME: '/Users/fixture' }, 'darwin')).toBe(systemChrome)
    stat.mockClear()
    stat.mockImplementation(() => { throw new Error('not installed') })
    expect(findSystemChrome({ HOME: 'relative-user' }, 'darwin')).toBeUndefined()
    expect(stat).toHaveBeenCalledExactlyOnceWith(systemChrome)
  })
})

describe('Chrome -> Edge -> Firefox fallback discovery', () => {
  const winEnv = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local',
  }
  const winChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  const winEdgeX86 = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  const winFirefox = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe'

  it('prefers Chrome over Edge and Firefox when multiple browsers are installed on Windows', () => {
    installed([winChrome, winEdgeX86, winFirefox])
    expect(findSystemBrowser(winEnv, 'win32')).toEqual({ kind: 'chrome', executable: winChrome })
  })

  it('falls back to Edge when Chrome is absent on Windows', () => {
    installed([winEdgeX86, winFirefox])
    expect(findSystemEdge(winEnv, 'win32')).toBe(winEdgeX86)
    expect(findSystemBrowser(winEnv, 'win32')).toEqual({ kind: 'edge', executable: winEdgeX86 })
  })

  it('falls back to Firefox when neither Chrome nor Edge is installed across platforms', () => {
    installed([winFirefox])
    expect(findSystemFirefox(winEnv, 'win32')).toBe(winFirefox)
    expect(findSystemBrowser(winEnv, 'win32')).toEqual({ kind: 'firefox', executable: winFirefox })

    const macFirefox = '/Users/fixture/Applications/Firefox.app/Contents/MacOS/firefox'
    installed([macFirefox])
    expect(findSystemBrowser({ HOME: '/Users/fixture' }, 'darwin')).toEqual({ kind: 'firefox', executable: macFirefox })

    installed(['/usr/bin/microsoft-edge-stable', '/usr/bin/firefox'])
    expect(findSystemBrowser({}, 'linux')).toEqual({ kind: 'edge', executable: '/usr/bin/microsoft-edge-stable' })

    installed(['/usr/bin/firefox'])
    expect(findSystemBrowser({}, 'linux')).toEqual({ kind: 'firefox', executable: '/usr/bin/firefox' })
  })

  it('returns undefined when none of Chrome, Edge, or Firefox is installed', () => {
    installed([])
    expect(findSystemBrowser(winEnv, 'win32')).toBeUndefined()
    expect(findSystemBrowser({ HOME: 'relative-user' }, 'darwin')).toBeUndefined()
    expect(findSystemBrowser({}, 'linux')).toBeUndefined()
  })
})
