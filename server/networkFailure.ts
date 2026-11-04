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

const FIXED_FAILURES: Record<string, { stage: StreamFailureStage; message: string }> = {
  'media-network-boundary': { stage: 'resolve', message: '播放列表或跳转尝试访问未授权的本机或局域网来源.' },
  'dns-failed': { stage: 'connect', message: '域名解析失败.' },
  'connection-refused': { stage: 'connect', message: '网络连接被拒绝.' },
  'connection-timeout': { stage: 'connect', message: '网络连接超时.' },
  'connection-failed': { stage: 'connect', message: '网络连接失败.' },
  'tls-certificate': { stage: 'connect', message: '服务器证书校验失败.' },
  'tls-failed': { stage: 'connect', message: 'TLS 连接失败.' },
  'proxy-resolution-failed': { stage: 'proxy', message: '无法取得系统代理决策, 请检查系统代理设置.' },
  'proxy-unreachable': { stage: 'proxy', message: '代理不可达, 请检查系统代理.' },
  'proxy-rejected': { stage: 'proxy', message: '代理拒绝连接或认证失败.' },
  'proxy-failed': { stage: 'proxy', message: '代理连接失败, 请检查系统代理.' },
  'socks4-unsupported': { stage: 'proxy', message: '当前不支持系统代理的 SOCKS4 类型, 请改用 SOCKS5 或 HTTP.' },
  'proxy-type-unsupported': { stage: 'proxy', message: '系统代理类型或地址不受支持, 请检查代理设置.' },
  'source-resolve-failed': { stage: 'resolve', message: '平台解析失败, 请检查直播状态后重试.' },
  'http-failed': { stage: 'http', message: '媒体服务器请求失败.' },
  'upstream-request-failed': { stage: 'connect', message: '媒体服务器请求失败, 请稍后重试.' },
  'redirect-limit': { stage: 'http', message: '服务器重定向次数过多, 请稍后重试.' },
  'media-format-invalid': { stage: 'playback-not-ready', message: '媒体格式无效或返回的内容不是可播放视频.' },
  'media-codec-unsupported': { stage: 'playback-not-ready', message: '当前媒体编码不受支持, 请切换画质或片源.' },
  'first-video-timeout': { stage: 'playback-not-ready', message: '等待可播放视频片段超时, 请稍后重试.' },
  'playback-not-ready': { stage: 'playback-not-ready', message: '尚未获得可播放的视频完整片段.' },
  'buffer-failed': { stage: 'playback-not-ready', message: '媒体缓冲失败, 请重新加载片源.' },
  'upstream-stalled': { stage: 'stall', message: '媒体连接后没有新的完整片段, 正在重试.' },
  'policy-rejected': { stage: 'resolve', message: '媒体地址被应用的安全策略拒绝.' },
  'invalid-url': { stage: 'resolve', message: '媒体地址格式无效.' },
  'bad-scheme': { stage: 'resolve', message: '媒体地址协议不受支持, 仅支持 HTTP/HTTPS.' },
  'bad-port': { stage: 'resolve', message: '媒体地址端口未获允许.' },
  'host-not-allowed': { stage: 'resolve', message: '媒体域名未获允许.' },
  'credentials-cross-origin': { stage: 'resolve', message: '请求被安全策略拒绝, 平台登录信息不能发送到其他来源.' },
}

/** Rebuild public failures from fixed codes, never from a provider's message or URL. */
export function streamFailureForCode(value: unknown): StreamFailure | undefined {
  if (typeof value !== 'string') return undefined
  if (/^http-[45]\d{2}$/.test(value)) return Number(value.slice(5)) === 407
    ? { code: 'proxy-rejected', ...FIXED_FAILURES['proxy-rejected']! } : httpFailure(Number(value.slice(5)))
  const code = value === 'too-many-redirects' ? 'redirect-limit' : value === 'upstream-failed' ? 'upstream-request-failed'
    : value === 'cross-origin-credentials' ? 'credentials-cross-origin' : value
  const failure = Object.hasOwn(FIXED_FAILURES, code) ? FIXED_FAILURES[code] : undefined
  return failure ? { code, ...failure } : undefined
}

export function streamFailureHint(code: unknown): string | undefined {
  const failure = streamFailureForCode(code)
  if (!failure) return undefined
  if (failure.code === 'media-network-boundary') return '如需播放该本地来源, 请直接添加它的媒体地址, 授权不会扩展到其他本地服务.'
  if (failure.stage === 'proxy') return '请确认代理软件已开启, 可在设置的网络选项中检查系统代理.'
  if (failure.code === 'dns-failed') return '请检查网络与 DNS 设置后重新加载.'
  if (failure.code === 'tls-certificate' || failure.code === 'tls-failed') return '请检查系统时间和网络证书设置后重试.'
  if (failure.stage === 'http') return '请确认直播仍在进行, 稍后重新加载或切换片源.'
  if (failure.code === 'media-format-invalid' || failure.code === 'media-codec-unsupported') return '请切换画质或使用其他可播放片源.'
  if (failure.stage === 'connect') return '请检查网络和出网设置后重新加载.'
  if (failure.stage === 'playback-not-ready' || failure.stage === 'stall') return '请稍后重新加载, 或切换画质和片源.'
  if (failure.code === 'source-resolve-failed') return '请检查房间地址和直播状态后重试.'
  return '请检查媒体地址是否有效, 并反馈此错误以核对应用的地址策略.'
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
  if (/invalid data found when processing input|invalid (?:media|container|playlist)|error parsing (?:the )?header|moov atom not found|could not detect (?:the )?format/i.test(text)) {
    return streamFailureForCode('media-format-invalid')
  }
  if (/unknown decoder|decoder .*not found|unsupported codec|codec .*not (?:currently )?supported|could not find codec parameters/i.test(text)) {
    return streamFailureForCode('media-codec-unsupported')
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
      const failure = streamFailureForCode(item.reason)
      if (failure) return failure
    }
    const code = typeof item.code === 'string' ? item.code : ''
    const status = item.statusCode ?? item.status
    if (code === 'UND_ERR_PROXY_HANDSHAKE_TIMEOUT') return { stage: 'proxy', code: 'proxy-unreachable', message: '代理握手超时, 请检查系统代理.' }
    if (status === 407 || /PROXY|PRX_/i.test(code)) return { stage: 'proxy', code: 'proxy-rejected', message: '代理不可达或拒绝连接.' }
    if (typeof status === 'number' && status >= 400 && status <= 599) return httpFailure(status)
    if (/ENOTFOUND|EAI_AGAIN|dns-failed/i.test(code)) return fallbackStage === 'proxy' ? unreachable()
      : { stage: 'connect', code: 'dns-failed', message: '域名解析失败.' }
    if (/ECONNREFUSED/i.test(code)) return fallbackStage === 'proxy' ? unreachable()
      : { stage: 'connect', code: 'connection-refused', message: '网络连接被拒绝.' }
    if (/TIMEOUT|ETIMEDOUT|TimeoutError/i.test(code) || item.name === 'TimeoutError') {
      return fallbackStage === 'proxy' ? unreachable() : { stage: 'connect', code: 'connection-timeout', message: '网络连接超时.' }
    }
    if (/ERR_TLS|ERR_SSL|TLS_FAILED/i.test(code)) return streamFailureForCode('tls-failed')!
    const known = streamFailureForCode(code)
    if (known) return known
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
