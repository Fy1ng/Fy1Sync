import type { Page, Route } from '@playwright/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadSource } from '../../e2e/helpers'
import { loadRecordingSource } from '../../e2e/recordingSources'

vi.mock('node:fs/promises', () => {
  const readFile = vi.fn()
  return { readFile, default: { readFile } }
})
vi.mock('../../e2e/helpers', () => {
  const loadSource = vi.fn()
  return { loadSource, default: { loadSource } }
})

beforeEach(() => { vi.clearAllMocks() })

describe('isolated recording test sources', () => {
  it.each([
    { range: undefined, status: 200, contentRange: undefined, expected: '0123456789' },
    { range: 'bytes=2-5', status: 206, contentRange: 'bytes 2-5/10', expected: '2345' },
    { range: 'bytes=6-', status: 206, contentRange: 'bytes 6-9/10', expected: '6789' },
    { range: 'bytes=6-99', status: 206, contentRange: 'bytes 6-9/10', expected: '6789' },
    { range: 'bytes=10-', status: 416, contentRange: 'bytes */10', expected: undefined },
  ])('serves an isolated recording for $range without opening a local-file UI', async ({ range, status, contentRange, expected }) => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from('0123456789'))
    const fulfill = vi.fn()
    const route = { request: () => ({ headers: () => ({ range }) }), fulfill } as unknown as Route
    const page = {
      unroute: vi.fn(),
      route: vi.fn(async (_url: string, handler: (route: Route) => Promise<void>) => { await handler(route) }),
    } as unknown as Page
    await loadRecordingSource(page, 'official', '.runtime-cache/recording.mp4', 'sample')
    expect(page.unroute).toHaveBeenCalledWith('app://app/test-sources/e2e-recordings/sample.mp4')
    expect(page.route).toHaveBeenCalledWith('app://app/test-sources/e2e-recordings/sample.mp4', expect.any(Function))
    expect(readFile).toHaveBeenCalledWith('.runtime-cache/recording.mp4')
    expect(loadSource).toHaveBeenCalledWith(page, 'official', '/test-sources/e2e-recordings/sample.mp4')
    const response = fulfill.mock.calls[0]![0] as { status: number; headers: Record<string, string>; body?: Buffer }
    expect(response.status).toBe(status)
    expect(response.headers['Content-Range']).toBe(contentRange)
    expect(response.body?.toString()).toBe(expected)
  })
})
