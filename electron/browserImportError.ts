export type BrowserImportErrorCode =
  | 'browser-import-unsupported' | 'browser-import-profile-missing' | 'browser-import-browser-in-use'
  | 'browser-import-decryption-failed' | 'browser-import-helper-missing' | 'browser-import-helper-invalid'
  | 'browser-import-uac-cancelled' | 'browser-import-cancelled' | 'browser-import-timeout'
  | 'browser-import-invalid-request' | 'browser-import-busy' | 'browser-import-preview-expired'
  | 'browser-import-verification-failed' | 'browser-import-storage-failed'

const messages: Record<BrowserImportErrorCode, string> = {
  'browser-import-unsupported': '当前系统暂不支持浏览器登录态导入.',
  'browser-import-profile-missing': '浏览器 Profile 已不存在, 请刷新列表后重试.',
  'browser-import-browser-in-use': '浏览器正在使用此 Profile. 请保存浏览内容并完全关闭该浏览器后重试.',
  'browser-import-decryption-failed': '无法读取浏览器登录凭据. 请检查 Windows 授权或使用平台官网登录.',
  'browser-import-helper-missing': '缺少浏览器凭据助手, 请重新安装完整应用.',
  'browser-import-helper-invalid': '浏览器凭据助手校验失败, 请重新安装完整应用.',
  'browser-import-uac-cancelled': 'Windows 授权已取消, 原有账号未更改.',
  'browser-import-cancelled': '已取消导入.',
  'browser-import-timeout': '读取浏览器登录态超时, 请关闭浏览器后重试.',
  'browser-import-invalid-request': '导入参数无效, 请重新打开导入窗口.',
  'browser-import-busy': '正在处理浏览器登录态, 请等待当前操作结束.',
  'browser-import-preview-expired': '账号预览已过期, 请重新识别后导入.',
  'browser-import-verification-failed': '暂时无法确认平台登录身份, 原有账号未更改.',
  'browser-import-storage-failed': '登录态保存失败, 请重试.',
}
export class BrowserImportError extends Error {
  constructor(readonly code: BrowserImportErrorCode) { super(messages[code]) }
}
export function importAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrowserImportError('browser-import-cancelled')
}
