import { describe, expect, it } from 'vitest'
import { createFeedbackReport } from './diagnosticReport'

describe('feedback report playback summary', () => {
  it('works before any video or acquisition attempt exists', () => {
    const report = createFeedbackReport({}, { version: 1, official: { samples: [], lastStall: null }, commentary: { samples: [], lastStall: null } })
    expect(report.schemaVersion).toBe(1)
    expect(report.acquisition.attempts).toEqual([])
    expect(report.playback).toEqual({
      official: { sampleCount: 0, latest: null, lastStall: null },
      commentary: { sampleCount: 0, latest: null, lastStall: null },
    })
  })

  it('keeps useful counters while excluding raw errors, source details and arbitrary stall text', () => {
    const report = createFeedbackReport({ Cookie: 'ACQUISITION_SECRET', attempts: [] }, {
      descriptor: { input: 'https://media.invalid/?token=INPUT_SECRET' },
      official: {
        samples: [{ at: 1793613600000, currentTime: 20, readyState: 2, paused: false, seeking: false, bufferAhead: 0.1,
          droppedFramesDelta: 3, timerLateMs: 100, url: 'https://private.invalid/MEDIA_SECRET',
          error: { type: 'NETWORK_SECRET', details: 'Cookie=COOKIE_SECRET' },
          localBuffer: { state: 'ready', seconds: 40, completeSegments: 20, path: 'C:/users/PATH_SECRET' } }],
        lastStall: { durationMs: 2500, category: 'fetch', ongoing: true, hint: 'STALL_SECRET',
          start: { token: 'TOKEN_SECRET' }, end: { header: 'HEADER_SECRET' } },
      },
      commentary: { samples: [], lastStall: null },
    })
    expect(report.playback.official).toEqual({ sampleCount: 1, latest: {
      at: 1793613600000, currentTime: 20, readyState: 2, paused: false, seeking: false, bufferAhead: 0.1,
      droppedFramesDelta: 3, timerLateMs: 100, localBuffer: { state: 'ready', seconds: 40, completeSegments: 20 },
    }, lastStall: { durationMs: 2500, category: 'fetch', ongoing: true } })
    expect(JSON.stringify(report)).not.toMatch(/SECRET|https:|Cookie|token|headers|descriptor|input|path|error|hint/)
  })

  it('normalizes malformed values and bounds numeric data without retaining unknown strings', () => {
    const report = createFeedbackReport(null, { official: {
      samples: [null, { at: Infinity, currentTime: 'PRIVATE', readyState: 99, paused: 'PRIVATE', seeking: true,
        bufferAhead: -1, droppedFramesDelta: 1e100, timerLateMs: NaN,
        localBuffer: { state: 'PRIVATE', seconds: Infinity, completeSegments: 1e100 } }],
      lastStall: { durationMs: -1, category: 'PRIVATE', ongoing: false },
    }, commentary: { samples: 'PRIVATE', lastStall: 'PRIVATE' } })
    expect(report.playback.official).toEqual({ sampleCount: 2, latest: {
      at: null, currentTime: null, readyState: null, paused: null, seeking: true,
      bufferAhead: null, droppedFramesDelta: 1e12, timerLateMs: null,
      localBuffer: { state: 'unknown', seconds: null, completeSegments: 1e6 },
    }, lastStall: { durationMs: null, category: 'unknown', ongoing: false } })
    expect(report.playback.commentary).toEqual({ sampleCount: 0, latest: null, lastStall: null })
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
  })
})
