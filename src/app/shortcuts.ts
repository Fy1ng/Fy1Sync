export const SHORTCUT_LABELS = {
  togglePlayback: '播放／暂停',
  seekBack: '主画面后退',
  seekForward: '主画面前进',
  nudgeBack: '回退画面',
  nudgeForward: '快进画面',
  autoAlign: '自动对齐',
  toggleDanmaku: '开关弹幕',
  toggleSidebar: '展开／收起弹幕栏',
  toggleFullscreen: '全屏',
} as const

export type ShortcutAction = keyof typeof SHORTCUT_LABELS
export type ShortcutBindings = Readonly<Record<ShortcutAction, readonly string[]>>

export const SHORTCUT_ACTIONS = Object.keys(SHORTCUT_LABELS) as ShortcutAction[]
export const MAX_SHORTCUT_KEYS = 2
export const SEEK_SHORTCUT_STEPS = { normal: 5, shift: 30 } as const

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  togglePlayback: ['Space'],
  seekBack: ['ArrowLeft'],
  seekForward: ['ArrowRight'],
  nudgeBack: ['Comma', 'BracketLeft'],
  nudgeForward: ['Period', 'BracketRight'],
  autoAlign: ['KeyA'],
  toggleDanmaku: ['KeyD'],
  toggleSidebar: ['KeyC'],
  toggleFullscreen: ['KeyF'],
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  Space: '空格', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Backspace: '退格', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'Page Up', PageDown: 'Page Down', ContextMenu: '菜单键', Pause: 'Pause', PrintScreen: 'Print Screen',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  IntlBackslash: '国际 \\', IntlRo: '国际 Ro', IntlYen: '¥',
  Convert: '转换', NonConvert: '无转换', KanaMode: '假名',
  NumpadAdd: '小键盘 +', NumpadSubtract: '小键盘 -', NumpadMultiply: '小键盘 *', NumpadDivide: '小键盘 /',
  NumpadDecimal: '小键盘 .', NumpadComma: '小键盘 ,', NumpadEqual: '小键盘 =',
}

export function isShortcutCode(value: unknown): value is string {
  return typeof value === 'string' && (Object.hasOwn(KEY_LABELS, value)
    || /^(?:Key[A-Z]|(?:Digit|Numpad)[0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(value))
}

export function shortcutKeyLabel(code: string): string {
  if (Object.hasOwn(KEY_LABELS, code)) return KEY_LABELS[code]!
  if (code.startsWith('Numpad')) return `小键盘 ${code.slice(6)}`
  return code.replace(/^(?:Key|Digit)/, '')
}

export function shortcutTitle(title: string, codes: readonly string[]): string {
  return codes.length ? `${title}（${codes.map(shortcutKeyLabel).join('、')}）` : title
}

export function shortcutActionFor(bindings: ShortcutBindings, code: string): ShortcutAction | undefined {
  return SHORTCUT_ACTIONS.find(action => bindings[action].includes(code))
}

export function normalizeShortcuts(raw: unknown): ShortcutBindings {
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const claimed = new Set<string>()
  const bindings = {} as Record<ShortcutAction, readonly string[]>
  for (const action of SHORTCUT_ACTIONS) {
    const codes = stored[action]
    if (!Array.isArray(codes) || codes.length > MAX_SHORTCUT_KEYS || !codes.every(isShortcutCode)
      || new Set(codes).size !== codes.length || codes.some(code => claimed.has(code))) continue
    bindings[action] = [...codes]
    for (const code of codes) claimed.add(code)
  }
  for (const action of SHORTCUT_ACTIONS) bindings[action] ??= DEFAULT_SHORTCUTS[action].filter(code => !claimed.has(code))
  return bindings
}
