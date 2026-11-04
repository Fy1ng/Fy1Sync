import { describe, expect, it } from 'vitest'
import { localMediaAddress, MediaAccessScope } from './mediaAccess'

describe('per-source media network authority', () => {
  it('accepts an explicitly selected LAN source and same-origin resources on its chosen port', () => {
    const scope = new MediaAccessScope('http://nas.lan:8080/live.m3u8')
    expect(scope.permits(new URL('http://nas.lan:8080/live.m3u8'), ['192.168.1.2'], true)).toBe(true)
    expect(scope.permits(new URL('http://nas.lan:8080/segment.ts'), ['192.168.1.2'], false)).toBe(true)
    expect(scope.permits(new URL('http://nas.lan:8000/admin'), ['192.168.1.2'], false)).toBe(false)
    expect(scope.permits(new URL('http://127.0.0.1:8080/secret'), ['127.0.0.1'], false)).toBe(false)
    expect(scope.permits(new URL('https://cdn.example/segment.ts'), ['93.184.216.34'], false)).toBe(true)
  })
  it('permits public CDN discovery but rejects local redirects, subresources and DNS rebinding', () => {
    const scope = new MediaAccessScope('https://media.example/live.m3u8')
    expect(scope.permits(new URL('https://media.example/live.m3u8'), ['93.184.216.34'], true)).toBe(true)
    expect(scope.permits(new URL('https://other.example:8443/segment.ts'), ['1.1.1.1'], false)).toBe(true)
    expect(scope.permits(new URL('http://127.0.0.1/secret'), ['127.0.0.1'], false)).toBe(false)
    expect(scope.permits(new URL('http://metadata.example/secret'), ['169.254.169.254'], false)).toBe(false)
    expect(scope.permits(new URL('https://media.example/segment.ts'), ['127.0.0.1'], false)).toBe(false)
    expect(scope.permits(new URL('https://media.example/live.m3u8'), ['127.0.0.1'], true)).toBe(false)
  })
  it('preserves delegated proxy DNS and accepts Fake-IP answers without treating them as LAN authority', () => {
    const scope = new MediaAccessScope('https://media.example/live.m3u8')
    expect(scope.permits(new URL('https://media.example/live.m3u8'), [], true)).toBe(true)
    expect(scope.permits(new URL('https://cdn.example/segment.ts'), [], false)).toBe(true)
    expect(scope.permits(new URL('http://localhost/secret'), [], false)).toBe(false)
    expect(scope.permits(new URL('https://cdn.example/segment.ts'), ['198.18.0.2'], false)).toBe(true)
    expect(scope.permits(new URL('https://media.example/segment.ts'), ['192.168.1.1'], false)).toBe(false)
  })
  it.each(['::1', '::', 'fc00::1', 'fe80::1', 'fec0::1', '::ffff:127.0.0.1', '::ffff:c0a8:101', '64:ff9b::c0a8:101'])('recognizes local IPv6 target %s', address => {
    expect(localMediaAddress(address)).toBe(true)
  })
  it.each(['198.18.1.2', '198.19.0.3', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('does not classify %s as a local service', address => {
    expect(localMediaAddress(address)).toBe(false)
  })
})
