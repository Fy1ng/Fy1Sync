export type BrowserImportErrorCode =
  | 'manual-cookie-invalid' | 'manual-cookie-incomplete' | 'manual-cookie-expired'
  | 'browser-import-unsupported' | 'browser-import-profile-missing' | 'browser-import-browser-in-use'
  | 'browser-import-decryption-failed' | 'browser-import-helper-missing' | 'browser-import-helper-invalid'
  | 'browser-import-uac-cancelled' | 'browser-import-cancelled' | 'browser-import-timeout'
  | 'browser-import-invalid-request' | 'browser-import-busy' | 'browser-import-preview-expired'
  | 'browser-import-verification-failed' | 'browser-import-storage-failed' | 'browser-import-close-failed'

const messages: Record<BrowserImportErrorCode, string> = {
  'manual-cookie-invalid': 'Cookie 格式无效，请使用 Cookie 请求头、JSON 或 Netscape cookies.txt（不超过 1 MB）',
  'manual-cookie-incomplete': '未找到所选平台的完整登录凭据，请重新复制 Cookie',
  'manual-cookie-expired': 'Cookie 登录已失效，请在浏览器重新登录后导入',
  'browser-import-unsupported': '当前系统不支持导入浏览器账号',
  'browser-import-profile-missing': '浏览器用户已不存在，请刷新浏览器列表后重试',
  'browser-import-browser-in-use': '此浏览器用户正在使用中。请先保存浏览内容，完全退出浏览器后重试。',
  'browser-import-decryption-failed': '无法读取浏览器登录凭据。请检查 Windows 授权或使用平台官网登录。',
  'browser-import-helper-missing': '浏览器导入组件缺失，请重新安装应用',
  'browser-import-helper-invalid': '浏览器导入组件未通过校验，请重新安装应用',
  'browser-import-uac-cancelled': '授权已取消，原账号未更改',
  'browser-import-cancelled': '已取消导入',
  'browser-import-timeout': '读取浏览器账号超时，请关闭浏览器后重试',
  'browser-import-invalid-request': '导入参数无效，请重新打开导入窗口',
  'browser-import-busy': '正在导入浏览器账号，请等待当前操作结束',
  'browser-import-preview-expired': '账号预览已过期，请重新识别后导入',
  'browser-import-verification-failed': '暂时无法确认平台登录身份，原有账号未更改',
  'browser-import-storage-failed': '账号保存失败，请重试',
  'browser-import-close-failed': '未能完全关闭对应浏览器，请先保存浏览内容，手动完全退出浏览器后重试。',
}
export class BrowserImportError extends Error {
  constructor(readonly code: BrowserImportErrorCode) { super(messages[code]) }
}
export function importAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrowserImportError('browser-import-cancelled')
}
