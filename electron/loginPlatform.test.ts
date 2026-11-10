import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findSystemChrome } from './login'

afterEach(() => vi.restoreAllMocks())

describe('macOS Chrome discovery', () => {
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const userChrome = '/Users/fixture/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  function installed(files: string[]) {
    return vi.spyOn(fs, 'statSync').mockImplementation(file => {
      if (!files.includes(String(file))) throw new Error('not installed')
      return { isFile: () => true } as ReturnType<typeof fs.statSync>
    })
  }

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
