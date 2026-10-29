export type StreamFailureStage = 'resolve' | 'proxy' | 'connect' | 'http' | 'stall' | 'playback-not-ready'

/** Only fixed codes, messages and numeric status values may cross the process boundary. */
export interface StreamFailure {
  stage: StreamFailureStage
  code: string
  message: string
  status?: number
}

export class StreamFailureError extends Error {
  constructor(readonly failure: StreamFailure) {
    super(failure.message)
    this.name = 'StreamFailureError'
  }
}

export function httpFailure(status: number): StreamFailure {
  return { stage: 'http', code: `http-${status}`, message: `服务器返回 HTTP ${status}.`, status }
}

/** Inspect diagnostics only for a bounded whitelist. Never forward source text. */
export function classifyFfmpegStderr(text: string): StreamFailure | undefined {
  if (/proxy.*(?:refus|reject|fail|407)|(?:refus|reject|fail).*proxy|HTTP (?:error )?407|CONNECT tunnel failed|Proxy response \([45]\d{2}\).*HTTP Tunneling/i.test(text)) {
    return { stage: 'proxy', code: 'proxy-rejected', message: '代理拒绝连接或认证失败.' }
  }
  const status = /(?:Server returned|HTTP error|HTTP\/\d(?:\.\d)?)[ :]+([45]\d{2})\b/i.exec(text)
  if (status) return Number(status[1]) === 407
    ? { stage: 'proxy', code: 'proxy-rejected', message: '代理拒绝连接或认证失败.' } : httpFailure(Number(status[1]))
  if (/certificate|cert verify|unable to verify|self[- ]signed/i.test(text)) {
    return { stage: 'connect', code: 'tls-certificate', message: '服务器证书校验失败.' }
  }
  if (/TLS|SSL|handshake/i.test(text)) return { stage: 'connect', code: 'tls-failed', message: 'TLS 连接失败.' }
  if (/resolve (?:host|hostname)|name or service not known|nodename nor servname|host not found|name resolution/i.test(text)) {
    return { stage: 'connect', code: 'dns-failed', message: '域名解析失败.' }
  }
  if (/connection refused/i.test(text)) return { stage: 'connect', code: 'connection-refused', message: '网络连接被拒绝.' }
  if (/timed? out|timeout/i.test(text)) return { stage: 'connect', code: 'connection-timeout', message: '网络连接超时.' }
  if (/network is unreachable|no route to host|connection reset|connection aborted|broken pipe/i.test(text)) {
    return { stage: 'connect', code: 'connection-failed', message: '网络连接中断.' }
  }
  return undefined
}

export function classifyNetworkFailure(error: unknown, fallbackStage: StreamFailureStage = 'connect'): StreamFailure {
  if (error instanceof StreamFailureError) return { ...error.failure }
  let current = error
  const chain: { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown; name?: unknown; reason?: unknown }[] = []
  for (let depth = 0; current && depth < 8; depth++) {
    if (current instanceof StreamFailureError) return { ...current.failure }
    if (typeof current !== 'object') break
    const item = current as typeof chain[number]
    chain.push(item)
    current = item.cause
  }
  // Target or HTTPS proxy certificate failures remain connection failures, even
  // when a wrapper reports a more generic proxy error around the certificate.
  if (chain.some(item => /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|CERTIFICATE/i.test(String(item.code ?? ''))
    || typeof item.message === 'string' && /certificate|cert verify|unable to verify|self[- ]signed/i.test(item.message))) {
    return { stage: 'connect', code: 'tls-certificate', message: '服务器证书校验失败.' }
  }
  const unreachable = (): StreamFailure => ({ stage: 'proxy', code: 'proxy-unreachable', message: '代理不可达, 请检查系统代理.' })
  for (const item of chain) {
    if (item.name === 'ProxyError') {
      if (item.reason === 'dns-failed') return { stage: 'connect', code: 'dns-failed', message: '域名解析失败.' }
      return { stage: 'resolve', code: 'policy-rejected', message: '目标地址未通过安全检查.' }
    }
    const code = typeof item.code === 'string' ? item.code : ''
    const status = item.statusCode ?? item.status
    if (status === 407 || /PROXY|PRX_/i.test(code)) return { stage: 'proxy', code: 'proxy-rejected', message: '代理不可达或拒绝连接.' }
    if (typeof status === 'number' && status >= 400 && status <= 599) return httpFailure(status)
    if (/ENOTFOUND|EAI_AGAIN|dns-failed/i.test(code)) return fallbackStage === 'proxy' ? unreachable()
      : { stage: 'connect', code: 'dns-failed', message: '域名解析失败.' }
    if (/ECONNREFUSED/i.test(code)) return fallbackStage === 'proxy' ? unreachable()
      : { stage: 'connect', code: 'connection-refused', message: '网络连接被拒绝.' }
    if (/TIMEOUT|ETIMEDOUT|TimeoutError/i.test(code) || item.name === 'TimeoutError') {
      return fallbackStage === 'proxy' ? unreachable() : { stage: 'connect', code: 'connection-timeout', message: '网络连接超时.' }
    }
    const classified = typeof item.message === 'string' ? classifyFfmpegStderr(item.message) : undefined
    if (classified?.stage === 'connect' && fallbackStage === 'proxy' && ['dns-failed', 'connection-refused', 'connection-timeout'].includes(classified.code)) return unreachable()
    if (classified) return classified
  }
  switch (fallbackStage) {
    case 'resolve': return { stage: 'resolve', code: 'source-resolve-failed', message: '平台解析失败, 请检查直播状态后重试.' }
    case 'proxy': return { stage: 'proxy', code: 'proxy-failed', message: '代理不可达或拒绝连接.' }
    case 'http': return { stage: 'http', code: 'http-failed', message: '媒体服务器返回错误.' }
    case 'stall': return { stage: 'stall', code: 'upstream-stalled', message: '媒体连接后没有新的完整片段, 正在重试.' }
    case 'playback-not-ready': return { stage: 'playback-not-ready', code: 'playback-not-ready', message: '尚未获得可播放的视频完整片段.' }
    default: return { stage: 'connect', code: 'connection-failed', message: '网络连接失败.' }
  }
}
