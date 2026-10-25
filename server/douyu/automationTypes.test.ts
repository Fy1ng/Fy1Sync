import { describe, expect, it } from 'vitest'
import { readAutomationRequest, type DouyuAutomationRequest } from './automationTypes'

const request = (): DouyuAutomationRequest => ({ taskId: 'task-1', accountId: 'account-1', kind: 'yuba-sign-all',
  target: { type: 'batch', source: 'followed-yuba' }, options: { yubaMode: 'supplement', maxSupplementCards: 2 } })

describe('automation request boundary', () => {
  it('detaches targets and options before asynchronous account work', () => {
    const raw: DouyuAutomationRequest = { ...request(), kind: 'follow-task', target: { type: 'account' }, options: { followRooms: ['123'] } }
    const parsed = readAutomationRequest(raw)
    raw.options.followRooms![0] = '456'
    raw.target = { type: 'room', room: '789' }
    expect(parsed.target).toEqual({ type: 'account' })
    expect(parsed.options.followRooms).toEqual(['123'])
  })

  it.each([
    { kind: 'followed-room-sign', target: { type: 'room', room: '123' }, options: {} },
    { kind: 'yuba-sign-all', options: { yubaMode: 'supplement' } },
    { kind: 'yuba-sign-all', options: { yubaMode: 'normal', maxSupplementCards: 1 } },
    { kind: 'yuba-sign-all', options: { yubaMode: 'supplement', maxSupplementCards: 0 } },
    { kind: 'yuba-sign-all', options: { yubaMode: 'fast' }, target: { type: 'group', groupId: '1' } },
    { kind: 'follow-task', target: { type: 'account' }, options: { followRooms: ['1', '1'] } },
    { kind: 'follow-task', target: { type: 'account' }, options: {} },
    { kind: 'yuba-read', target: { type: 'account' }, options: { postIds: ['https://evil.test/'] } },
    { kind: 'client-sign', target: { type: 'account' }, options: { url: 'https://evil.test/' } },
    { kind: 'arena-sign', target: { type: 'room', room: '1' }, options: { activityId: '123' } },
    { kind: 'watch-points', target: { type: 'account' }, options: { actAlias: 'obsolete' } },
    { kind: 'watch-points', target: { type: 'account' }, options: { maxItems: 2001 } },
    { taskId: '../unsafe' }, { accountId: 'account\n2' }, { target: { type: 'room', room: '01' } },
  ])('rejects incompatible, consuming or caller-defined protocol options %#', patch => {
    expect(() => readAutomationRequest({ ...request(), ...patch })).toThrow('参数无效')
  })

  it('never invokes option or array accessors', () => {
    let reads = 0
    const options = Object.defineProperty({}, 'maxItems', { get: () => { reads++; return 1 }, enumerable: true })
    expect(() => readAutomationRequest({ ...request(), options })).toThrow()
    const rooms = ['1']
    Object.defineProperty(rooms, '0', { get: () => { reads++; return '1' } })
    expect(() => readAutomationRequest({ ...request(), kind: 'follow-task', target: { type: 'account' }, options: { followRooms: rooms } })).toThrow()
    expect(reads).toBe(0)
  })
})
