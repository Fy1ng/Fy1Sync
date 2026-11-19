/** Public login diagnostics contain fixed categories and numbers, never upstream text. */
const REQUEST_STAGES = ['bootstrap', 'token', 'qr', 'poll', 'sms-send', 'sms-login', 'password-login', 'redirect', 'identity'] as const
export type DouyinHttpRequestStage = typeof REQUEST_STAGES[number]
const NETWORK_CODES = ['dns-failed', 'connection-refused', 'connection-timeout', 'connection-failed', 'tls-certificate', 'tls-failed',
  'proxy-resolution-failed', 'proxy-unreachable', 'proxy-rejected', 'proxy-failed', 'socks4-unsupported', 'proxy-type-unsupported',
  'upstream-request-failed', 'policy-rejected', 'host-not-allowed'] as const
export type DouyinHttpNetworkCode = typeof NETWORK_CODES[number]
const FAILURE_CODES = new Set(['douyin-http-login-failed', 'douyin-http-login-cancelled', 'douyin-http-login-timeout',
  'douyin-http-login-network-unavailable', 'douyin-http-login-token-unavailable', 'douyin-http-login-identity-unavailable',
  'douyin-http-ticket-mismatch', 'douyin-http-login-destination-invalid', 'douyin-http-login-rejected', 'douyin-http-qr-invalid',
  'douyin-http-login-not-ready', 'douyin-http-login-busy', 'douyin-http-sms-cooldown', 'douyin-http-login-input-invalid',
  'douyin-http-login-receipt-invalid', 'douyin-http-login-redirect-limit', 'douyin-http-qr-receipt-invalid', 'douyin-http-cookie-invalid'])

export type DouyinHttpLoginFailure = {
  code: string
  platformCode?: number
  httpStatus?: number
  requestStage?: DouyinHttpRequestStage
  networkCode?: DouyinHttpNetworkCode
}

function own(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  try { const field = Object.getOwnPropertyDescriptor(value, name); return field && 'value' in field ? field.value : undefined }
  catch { return undefined }
}

/** Read only allow-listed data descriptors, even when an error supplies hostile accessors. */
export function douyinHttpLoginFailureDetails(error: unknown): DouyinHttpLoginFailure {
  const code = own(error, 'code'), platformCode = own(error, 'platformCode'), httpStatus = own(error, 'httpStatus')
  const requestStage = own(error, 'requestStage'), networkCode = own(error, 'networkCode')
  return { code: typeof code === 'string' && FAILURE_CODES.has(code) ? code : 'douyin-http-login-failed',
    ...(typeof platformCode === 'number' && Number.isSafeInteger(platformCode) ? { platformCode } : {}),
    ...(typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(typeof requestStage === 'string' && REQUEST_STAGES.includes(requestStage as DouyinHttpRequestStage) ? { requestStage: requestStage as DouyinHttpRequestStage } : {}),
    ...(typeof networkCode === 'string' && NETWORK_CODES.includes(networkCode as DouyinHttpNetworkCode) ? { networkCode: networkCode as DouyinHttpNetworkCode } : {}) }
}

const STAGE_LABELS: Record<DouyinHttpRequestStage, string> = { bootstrap: '初始化抖音登录', token: '建立抖音登录会话',
  qr: '获取抖音二维码', poll: '读取抖音扫码状态', 'sms-send': '发送抖音短信验证码', 'sms-login': '抖音短信登录',
  'password-login': '抖音密码登录', redirect: '完成抖音登录', identity: '确认抖音账号' }
const NETWORK_MESSAGES: Record<DouyinHttpNetworkCode, string> = {
  'dns-failed': '域名解析失败，请检查网络和 DNS 设置后手动重试',
  'connection-refused': '网络连接被拒绝，请检查网络后手动重试',
  'connection-timeout': '网络连接超时，请检查网络后手动重试',
  'connection-failed': '网络连接失败，请检查网络后手动重试',
  'tls-certificate': '服务器证书校验失败，请检查系统时间和网络证书后重试',
  'tls-failed': '安全连接建立失败，请检查网络后手动重试',
  'proxy-resolution-failed': '无法取得系统代理设置，请检查代理后重试',
  'proxy-unreachable': '代理不可达，请检查代理后重试',
  'proxy-rejected': '代理拒绝连接，请检查代理后重试',
  'proxy-failed': '代理连接失败，请检查代理后重试',
  'socks4-unsupported': '当前代理使用 SOCKS4，请改用 SOCKS5 或 HTTP 后重试',
  'proxy-type-unsupported': '系统代理类型不受支持，请检查代理设置后重试',
  'upstream-request-failed': '网络请求未完成，请检查网络后手动重试',
  'policy-rejected': '请求地址未通过应用校验，请反馈此错误',
  'host-not-allowed': '请求域名未通过应用校验，请反馈此错误',
}

/** A failed account or platform response must not masquerade as a network failure. */
export function douyinHttpLoginFailureMessage(error: unknown): string {
  const value = douyinHttpLoginFailureDetails(error)
  const subject = value.requestStage ? STAGE_LABELS[value.requestStage] : '抖音登录'
  if (value.code === 'douyin-http-login-cancelled') return '已取消抖音登录'
  if (value.code === 'douyin-http-login-timeout') return subject + '超时，请检查网络后手动重试'
  if (value.code === 'douyin-http-login-network-unavailable') return subject + '失败：' + NETWORK_MESSAGES[value.networkCode ?? 'upstream-request-failed']
  if (value.code === 'douyin-http-login-input-invalid') return '请填写有效的抖音手机号，密码或短信验证码'
  if (value.code === 'douyin-http-login-identity-unavailable') return '抖音尚未确认当前直播登录身份，原登录记录已保留'
  if (value.code === 'douyin-http-ticket-mismatch') return '未能开启抖音弹幕发送，请重新登录'
  if (value.platformCode === 7) return '操作过于频繁，请稍后重试'
  if (value.platformCode !== undefined) return '抖音未接受此次登录，请检查登录信息后重试'
  if (value.httpStatus !== undefined && value.httpStatus >= 300) return '抖音暂时无法完成登录，请稍后重试'
  if (value.code === 'douyin-http-login-token-unavailable') return '抖音登录初始化失败，请刷新二维码后重试'
  if (value.code === 'douyin-http-qr-invalid') return '抖音未返回有效的登录二维码，请手动刷新二维码后重试'
  if (value.code === 'douyin-http-login-receipt-invalid' || value.code === 'douyin-http-qr-receipt-invalid') return subject + '返回的结果不完整，尚未确认登录成功，请手动重试'
  if (value.code === 'douyin-http-cookie-invalid') return '抖音返回的登录凭据未通过校验，未保存新登录记录'
  if (value.code === 'douyin-http-login-destination-invalid' || value.code === 'douyin-http-login-redirect-limit') return '抖音登录跳转未通过校验，未保存新登录记录'
  if (value.code === 'douyin-http-login-not-ready') return '抖音登录初始化尚未完成，请手动刷新二维码后重试'
  if (value.code === 'douyin-http-login-busy') return '请先完成当前抖音登录步骤'
  if (value.code === 'douyin-http-sms-cooldown') return '请等待抖音短信验证码冷却结束后重试'
  if (value.code === 'douyin-http-login-rejected') return subject + '被抖音拒绝，请稍后手动重试'
  return '抖音登录未完成，请重试'
}
