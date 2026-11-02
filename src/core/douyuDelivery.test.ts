import { describe, expect, it } from 'vitest'
import { roomEchoConfirmsSend } from './douyuDelivery'

describe('strictly observed room delivery outcome', () => {
  it('promotes only an unknown receipt with the strict room observation', () => {
    expect(roomEchoConfirmsSend({ gateway: 'unknown', roomEcho: 'observed' })).toBe(true)
    for (const gateway of ['pending', 'accepted', 'rejected', 'unknown'] as const) {
      for (const roomEcho of ['pending', 'observed', 'not-observed'] as const) {
        if (gateway === 'unknown' && roomEcho === 'observed') continue
        expect(roomEchoConfirmsSend({ gateway, roomEcho })).toBe(false)
      }
    }
    expect(roomEchoConfirmsSend(null)).toBe(false)
  })
})
