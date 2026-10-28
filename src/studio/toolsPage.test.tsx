/**
 * 取流工具 warns only when ffmpeg is not the bundled build, whose certificate checks are known.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { Tools } from './SettingsSheet'

function stub(source: 'bundled' | 'external' | 'PATH'): void {
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string) => method === 'getToolsStatus'
      ? { ok: true, value: { tools: [{ name: 'ffmpeg', source, version: '8.1.3', available: true }], fixturesAvailable: false,
        provider: { available: true, source: 'bundled' }, update: { phase: 'idle', message: '', downloadedBytes: 0, totalBytes: 0 } } }
      : { ok: true, value: {} }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('取流工具', () => {
  it('says nothing extra for the bundled ffmpeg', async () => {
    stub('bundled')
    render(<Tools />)
    expect(await screen.findByText('内置', { exact: false })).toBeInTheDocument()
    expect(screen.queryByText(/非内置的 ffmpeg/)).toBeNull()
  })

  it.each(['external', 'PATH'] as const)('warns about certificate checks for a %s ffmpeg', async (source) => {
    stub(source)
    render(<Tools />)
    expect(await screen.findByText(/非内置的 ffmpeg/)).toBeInTheDocument()
  })
})
