/** The preload reports the OS without exposing Node or accepting renderer overrides. */
export function isMacOS(): boolean {
  const platform = window.streamSyncer?.platform
  return platform ? platform === 'darwin' : /^Mac/i.test(navigator.platform)
}

export function primaryModifier(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>): boolean {
  return isMacOS() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export function shortcutLabel(key: string): string {
  return `${isMacOS() ? 'Cmd' : 'Ctrl'}+${key}`
}
