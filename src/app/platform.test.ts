import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMacOS, primaryModifier, shortcutLabel } from './platform'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('desktop keyboard platform', () => {
  it.each(['win32', 'darwin', 'linux'])('uses the native bridge on %s, even with a different browser platform', platform => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    vi.stubGlobal('streamSyncer', { platform })
    expect(isMacOS()).toBe(platform === 'darwin')
    expect(primaryModifier({ ctrlKey: false, metaKey: true })).toBe(platform === 'darwin')
    expect(primaryModifier({ ctrlKey: true, metaKey: false })).toBe(platform !== 'darwin')
    expect(primaryModifier({ ctrlKey: true, metaKey: true })).toBe(false)
    expect(primaryModifier({ ctrlKey: false, metaKey: false })).toBe(false)
    expect(shortcutLabel('Z')).toBe(platform === 'darwin' ? 'Cmd+Z' : 'Ctrl+Z')
  })

  it('supports a browser or older preload without exposing Node', () => {
    vi.stubGlobal('streamSyncer', undefined)
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    expect(isMacOS()).toBe(true)
    expect(shortcutLabel('V')).toBe('Cmd+V')
  })
})
