import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron'

export function mainWindowChrome(platform: NodeJS.Platform): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'frame' | 'thickFrame' | 'trafficLightPosition'> {
  return { titleBarStyle: 'hidden', frame: true,
    ...(platform === 'win32' ? { thickFrame: true } : {}),
    ...(platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 9 } } : {}),
  }
}

/** Native roles keep macOS text editing, application hiding and window shortcuts intact. */
export function applicationMenu(platform: NodeJS.Platform, showMainWindow: () => void): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null
  return [
    { label: 'Fy1Sync', submenu: [
      { role: 'about', label: '关于 Fy1Sync' },
      { type: 'separator' },
      { role: 'services', label: '服务' },
      { type: 'separator' },
      { role: 'hide', label: '隐藏 Fy1Sync' },
      { role: 'hideOthers', label: '隐藏其他应用' },
      { role: 'unhide', label: '显示全部' },
      { type: 'separator' },
      { role: 'quit', label: '退出 Fy1Sync' },
    ] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
      { role: 'selectAll', label: '全选' },
    ] },
    { label: '显示', submenu: [{ role: 'togglefullscreen', label: '切换全屏' }] },
    { label: '窗口', role: 'windowMenu', submenu: [
      { id: 'show-main-window', label: '显示主窗口', click: showMainWindow },
      { type: 'separator' },
      { role: 'minimize', label: '最小化' },
      { role: 'zoom', label: '缩放' },
      { role: 'close', label: '关闭窗口' },
      { type: 'separator' },
      { role: 'front', label: '前置全部窗口' },
    ] },
  ]
}
