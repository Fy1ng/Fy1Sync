/** Strip origin-bound material without preventing an anonymous cross-origin read. */
export function sensitiveHeader(name: string): boolean {
  return /^(?:cookie2?|authorization|proxy-authorization)$/i.test(name)
    || /(?:token|secret|csrf|api[-_]?key|^x-auth)/i.test(name)
}

export function withoutSourceCredentials(headers?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !sensitiveHeader(name) && name.toLowerCase() !== 'host'))
}

export function mediaUrlCredentials(raw: string, headers?: Record<string, string>): { url: URL; headers: Record<string, string> } {
  const url = new URL(raw)
  const result = { ...headers }
  if (url.username || url.password) {
    const authorization = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`, 'utf8').toString('base64')
    if (!Object.keys(result).some(name => name.toLowerCase() === 'authorization')) result.Authorization = `Basic ${authorization}`
    url.username = ''; url.password = ''
  }
  return { url, headers: result }
}
