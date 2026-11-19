/** Synthetic mutations supplement the independently encoded, live-derived golden vectors. */
import { HuyaTarsWriter as Writer } from '../huyaWup'
export const huyaOnTvIdentity = { room: '99798', presenterUid: 1024n, topSid: 0n, subSid: 0n }
export function huyaOnTvWire(options: { state?: number; mode?: number; participation?: number; id?: bigint; dataId?: bigint;
  presenter?: bigint; left?: number; end?: bigint; prices?: number[]; counts?: number[]; prize?: string; method?: string } = {}): Uint8Array {
  const structure = (tag: number, write: (w: Writer) => void, out: Writer) => { out.head(tag, 10); write(out); out.head(0, 11) }
  const panel = new Writer()
  structure(0, w => {
    w.int(0, options.state ?? 1)
    structure(2, info => {
      info.int64(0, options.id ?? 4096n)
      structure(1, setting => {
        setting.string(0, '合成上电视主题')
        structure(1, award => award.string(0, options.prize ?? '合成奖品 1份'), setting)
        const prices = options.prices ?? []
        setting.head(2, 9); setting.int(0, prices.length)
        for (const price of prices) structure(0, p => p.int(1, price), setting)
        setting.int64(3, options.presenter ?? 1024n); setting.int(5, options.mode ?? 2)
        const counts = options.counts ?? []
        setting.head(6, 9); setting.int(0, counts.length)
        for (const count of counts) structure(0, p => p.int(1, count), setting)
        setting.int(7, options.participation ?? 0)
      }, info)
      structure(2, data => {
        data.int64(0, options.dataId ?? options.id ?? 4096n); data.int(3, options.left ?? 60); data.int64(5, options.end ?? 1800000200n)
      }, info)
    }, w)
  }, panel)
  const payload = new Writer()
  payload.head(0, 8); payload.int(0, 2); payload.string(0, ''); payload.bytes(1, Buffer.from([12])); payload.string(0, 'tRsp'); payload.bytes(1, panel.finish())
  const packet = new Writer()
  packet.int(1, 3); packet.int(4, 1); packet.string(5, 'revenueui'); packet.string(6, options.method ?? 'getOnTVPanel'); packet.bytes(7, payload.finish())
  const body = packet.finish(), length = Buffer.alloc(4); length.writeUInt32BE(body.length + 4)
  return new Uint8Array(Buffer.concat([length, body]))
}
