import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeHuyaOnTvPanel, encodeHuyaOnTvRequest, huyaOnTvOfficialUrl, readHuyaOnTvPanel } from './huyaOnTv'
import { HuyaTarsReader } from './huyaWup'
import golden from './fixtures/huya-on-tv.json'
import { huyaOnTvIdentity as identity, huyaOnTvWire } from './fixtures/huyaOnTvFixture'
import { safeFetch } from '../safeFetch'
vi.mock('../safeFetch', () => ({ safeFetch: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
const read = (options: Parameters<typeof huyaOnTvWire>[0] = {}) => decodeHuyaOnTvPanel(huyaOnTvWire(options), identity, 1800000000000)
describe('HuyaOnTv bounded read-only protocol', () => {
  it('decodes independent live-derived golden active and empty panels', () => {
    const active = decodeHuyaOnTvPanel(Buffer.from(golden.active, 'hex'), identity, 1800000000000)
    expect(active.status).toBe('active')
    expect(active.activity).toMatchObject({ id: golden.expected.id, mode: 2, prize: 'Synthetic prize 1 item', qualification: 'unknown' })
    expect(active.activity!.endsAt - active.activity!.serverNow).toBe(golden.expected.remaining * 1000)
    expect(active.activity!.cost).toContain('指定礼物 x10 / x30')
    expect(decodeHuyaOnTvPanel(Buffer.from(golden.inactive, 'hex'), identity, 1800000000000)).toMatchObject({ status: 'none', activity: null })
  })
  it.each([
    [{ mode: 2, participation: 0 }, '指定礼物'], [{ mode: 6 }, '虎粮'], [{ mode: 10 }, '官方 PC'],
    [{ mode: 7 }, 'App/游戏'], [{ mode: 8 }, 'App/游戏'], [{ mode: 9 }, 'App/游戏'],
    [{ mode: 0, prices: [0, 100] }, '无消耗选项和有消耗选项'], [{ mode: 1, prices: [100] }, '单位待官网确认'],
    [{ mode: 0, prices: [] }, '费用未知'], [{ mode: 100 }, '费用未知'],
  ])('classifies mode and cost conservatively: %j', (options, expected) => {
    expect(read(options).activity!.cost).toContain(expected)
    expect(read(options).activity!.qualification).toBe('unknown')
  })
  it.each([1, 2, 3, 4, 5, 6, 7, 999])('keeps personal eligibility unknown for condition %s', participation => {
    const activity = read({ participation }).activity!
    expect(activity.conditions).toContain('个人资格和剩余额度未查询')
    expect(activity.qualification).toBe('unknown')
  })
  it.each([{ left: 0 }, { state: 2 }, { state: 3 }])('treats expired/settling/result panels as ended: %j', options => expect(read(options).status).toBe('ended'))
  it.each([{ dataId: 33n }, { presenter: 33n }, { id: 0n }, { state: 4 }, { left: -1 }, { left: 86401 }, { end: 0n },
    { method: 'sendOnTVBarrage' }, { counts: Array(129).fill(1) }, { prize: 'x'.repeat(513) }])('rejects mismatched or unbounded metadata', options => expect(() => read(options)).toThrow())
  it('rejects wrong packet length and oversized input', () => {
    const bytes = huyaOnTvWire(); bytes[3] = 0
    expect(() => decodeHuyaOnTvPanel(bytes, identity, 0)).toThrow()
    expect(() => decodeHuyaOnTvPanel(new Uint8Array(65537), identity, 0)).toThrow()
  })
  it('encodes only the anonymous getOnTVPanel method', () => {
    const bytes = encodeHuyaOnTvRequest(identity), reader = new HuyaTarsReader(bytes.subarray(4))
    const strings: string[] = []
    while (!reader.done) { const [, type] = reader.head(); if (type === 6 || type === 7) strings.push(reader.string(type)); else reader.skip(type) }
    expect(strings).toEqual(['revenueui', 'getOnTVPanel'])
    expect(Buffer.from(bytes).toString()).not.toMatch(/udb_|Cookie|sendOnTV|gift|follow/)
  })
  it.each(['https://www.huya.com/99798', 'huya:kpl', 'huya:01', 'huya:99798?x=1', 'huya:1/../2', 'douyu:99798', 'huya:99999999999999999'])('refuses an arbitrary official-entry input: %s', room => expect(() => huyaOnTvOfficialUrl(room)).toThrow())
  it('builds a fixed official room URL', () => expect(huyaOnTvOfficialUrl('huya:99798')).toBe('https://www.huya.com/99798'))
  it('reads only the fixed WUP origin, without any account headers', async () => {
    vi.mocked(safeFetch).mockResolvedValue({ response: new Response(new Uint8Array(huyaOnTvWire())), finalUrl: new URL('https://wup.huya.com') })
    const controller = new AbortController()
    await readHuyaOnTvPanel(identity, controller.signal)
    expect(safeFetch).toHaveBeenCalledWith('https://wup.huya.com', expect.objectContaining({ hosts: ['wup.huya.com'], maxRedirects: 0 }), expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Referer: 'https://www.huya.com/', 'User-Agent': 'Mozilla/5.0' } }))
  })
  it('cancels oversized response bodies before parsing', async () => {
    vi.mocked(safeFetch).mockResolvedValue({ response: new Response(new Uint8Array(65537)), finalUrl: new URL('https://wup.huya.com') })
    await expect(readHuyaOnTvPanel(identity, new AbortController().signal)).rejects.toThrow('暂不可用')
  })
})
