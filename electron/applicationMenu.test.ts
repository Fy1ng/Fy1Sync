import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenu, mainWindowChrome } from './applicationMenu'

describe('platform desktop chrome', () => {
  it('keeps native macOS traffic lights inside the reserved title strip', () => {
    expect(mainWindowChrome('darwin')).toEqual({ titleBarStyle: 'hidden', frame: true, trafficLightPosition: { x: 12, y: 9 } })
    expect(mainWindowChrome('win32')).toEqual({ titleBarStyle: 'hidden', frame: true, thickFrame: true })
  })

  it('provides macOS editing and application roles plus a way to reopen the main window', () => {
    const show = vi.fn(), menu = applicationMenu('darwin', show)!
    const items = menu.flatMap(group => group.submenu as MenuItemConstructorOptions[])
    expect(items.map(item => item.role)).toEqual(expect.arrayContaining(['quit', 'hide', 'hideOthers', 'unhide', 'undo', 'redo', 'copy', 'paste', 'cut', 'selectAll', 'minimize', 'zoom', 'close', 'togglefullscreen']))
    expect(items.find(item => item.id === 'show-main-window')?.click).toBe(show)
    expect(items.some(item => item.role === 'reload' || item.role === 'toggleDevTools')).toBe(false)
    expect(applicationMenu('win32', show)).toBeNull()
    expect(applicationMenu('linux', show)).toBeNull()
  })
})
