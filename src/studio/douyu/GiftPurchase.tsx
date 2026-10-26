/**
 * Buying a current gift and sending it repeatedly (handoff item 56). Reading the catalog
 * never sends anything; quantity, count and interval are always typed by the viewer and
 * shown again on the confirmation page. The catalog's countLimit of 0 means "no declared
 * limit", not "out of stock" — whether a gift can be sent is `available` plus the preview.
 */

import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { DouyuGiftCatalog, DouyuGiftPlan } from '../../../server/douyu/inventoryTypes'
import { planShapeOk, type GiftPlanHandle } from './giftPlan'
import { dateTime, money, roomOk, wholeIn } from './giftFormat'
import './backpack.css'

const MAX_REPEAT = 10_000
const MAX_SPAN_MS = 86_400_000

export function GiftPurchase({ accountId, room, gift, locked, ready }: {
  accountId: string
  room: string
  gift: GiftPlanHandle
  locked: boolean
  ready: boolean
}): React.ReactNode {
  const [catalog, setCatalog] = useState<DouyuGiftCatalog | null>(null)
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState('')
  const [giftId, setGiftId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [repeat, setRepeat] = useState('')
  const [gap, setGap] = useState('1000')
  const mounted = useRef(false)
  const generation = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++ }
  }, [])

  const load = async (): Promise<void> => {
    if (!roomOk(room) || reading || locked) return
    const mine = ++generation.current
    const asked = room
    setReading(true); setReadError('')
    try {
      const response = await apiClient.feature('getDouyuGiftCatalog', { room: asked })
      if (!mounted.current || mine !== generation.current) return
      if (!response.ok) { setReadError(response.message); return }
      const value = response.value
      if (!value || value.room !== asked || !Array.isArray(value.items)) throw new Error('bad catalog')
      setCatalog(value)
      if (!value.items.some((item) => item.giftId === giftId && item.available)) {
        if (giftId) gift.discard()
        setGiftId('')
      }
    } catch {
      if (mounted.current && mine === generation.current) setReadError('礼物目录读取失败，请重试。')
    } finally {
      if (mounted.current && mine === generation.current) setReading(false)
    }
  }

  const chosen = catalog?.items.find((item) => item.giftId === giftId) ?? null
  const limit = chosen && chosen.countLimit !== null && chosen.countLimit > 0 ? chosen.countLimit : null
  const perSend = wholeIn(quantity, 1, limit ?? Number.MAX_SAFE_INTEGER)
  const times = wholeIn(repeat, 1, MAX_REPEAT)
  const intervalMs = wholeIn(gap, 0, 60_000)
  const tooLong = times !== null && intervalMs !== null && intervalMs * (times - 1) > MAX_SPAN_MS
  const tooMany = perSend !== null && times !== null && !Number.isSafeInteger(perSend * times)
  const formOk = roomOk(room) && !!chosen?.available && perSend !== null && times !== null && intervalMs !== null && !tooLong && !tooMany

  const edit = (apply: () => void): void => { if (locked) return; gift.discard(); apply() }

  const preview = (): void => {
    if (!formOk || !chosen || perSend === null || times === null || intervalMs === null || locked) return
    const input = { room, giftId: chosen.giftId, quantity: perSend, repeat: times, intervalMs }
    const accepts = (value: unknown): value is DouyuGiftPlan => {
      if (!planShapeOk(value, accountId, room, 'purchase')) return false
      const row = value.rows[0]!
      // Every number the viewer typed must come back unchanged; the confirmation shows the plan.
      return value.rows.length === 1 && row.giftId === input.giftId && row.quantity === input.quantity && row.repeat === input.repeat
        && value.repeat === input.repeat && value.intervalMs === input.intervalMs && value.totalOperations === input.repeat
    }
    void gift.preview(() => apiClient.feature('previewDouyuPurchaseGift', { accountId, input }), accepts)
  }

  return (
    <div className="gift-form">
      <div className="gift-line">
        <button type="button" className={catalog ? 'btn-quiet small' : 'btn-solid small'}
          disabled={!ready || !roomOk(room) || reading || locked} onClick={() => void load()}>
          {reading ? '读取中…' : catalog ? '重新读取礼物目录' : '读取礼物目录'}
        </button>
        {catalog && <span className="muted num">房间 {catalog.room} · 读取于 {dateTime(catalog.checkedAt)}{catalog.onceLimit !== null ? ` · 单次上限 ${catalog.onceLimit}` : ''}</span>}
      </div>
      {readError && <p className="form-error" role="alert">{readError}</p>}
      <p className="muted">将以账号余额购买并赠送，不使用背包库存。价格以鱼翅（YUCHI，scale 100）或鱼丸（YUWAN，scale 1）计，均非人民币金额。</p>

      {catalog && (catalog.items.length === 0 ? <p className="muted">目录中没有礼物。</p> : (
        <ul className="gift-catalog" role="radiogroup" aria-label="礼物目录">
          {catalog.items.map((item) => (
            <li key={item.giftId} data-on={item.giftId === giftId} data-off={!item.available}>
              <label>
                <input type="radio" name="gift-catalog" checked={item.giftId === giftId} disabled={locked || !item.available}
                  aria-label={`${item.name}（ID ${item.giftId}）`}
                  onChange={() => edit(() => setGiftId(item.giftId))} />
                <span className="gift-pick-name">{item.name} <span className="muted num">ID {item.giftId}</span></span>
                <span className="num">{money(item.unitPrice)}</span>
                <span className="muted">
                  {item.available ? '可赠' : item.unavailableReason || '当前不可赠'}
                  {item.countLimit !== null && item.countLimit > 0 ? ` · 每次最多 ${item.countLimit}` : ''}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ))}

      {catalog && (
        <div className="gift-line gift-numbers">
          <label className="gift-field">
            <span>每次数量</span>
            <input className="text-input num" inputMode="numeric" value={quantity} disabled={locked} aria-label="每次数量"
              aria-invalid={quantity !== '' && perSend === null} onChange={(event) => { const next = event.target.value; edit(() => setQuantity(next)) }} />
          </label>
          <label className="gift-field">
            <span>次数</span>
            <input className="text-input num" inputMode="numeric" value={repeat} disabled={locked} aria-label="赠送次数"
              aria-invalid={repeat !== '' && times === null} onChange={(event) => { const next = event.target.value; edit(() => setRepeat(next)) }} />
          </label>
          <label className="gift-field">
            <span>间隔</span>
            <input className="text-input num" inputMode="numeric" value={gap} disabled={locked} aria-label="购买赠送间隔（毫秒）"
              aria-invalid={intervalMs === null} onChange={(event) => { const next = event.target.value; edit(() => setGap(next)) }} />
            <span>毫秒</span>
          </label>
        </div>
      )}
      {catalog && quantity !== '' && perSend === null && <p className="form-error">每次数量须为{limit ? ` 1 到 ${limit} ` : '正'}整数</p>}
      {catalog && repeat !== '' && times === null && <p className="form-error">次数须为 1 到 {MAX_REPEAT} 的整数</p>}
      {catalog && intervalMs === null && <p className="form-error">间隔须为 0 到 60000 的整数</p>}
      {(tooLong || tooMany) && <p className="form-error">计划总时长不得超过 24 小时，总量须在可计算范围内</p>}
      {!roomOk(room) && <p className="form-error">请填写有效的目标房间号</p>}

      {catalog && (
        <div className="gift-actions">
          <button type="button" className={gift.plan ? 'btn-quiet small' : 'btn-solid small'}
            disabled={!ready || !formOk || locked || !!gift.busy} onClick={preview}>
            {gift.busy === 'plan' ? '生成中…' : gift.plan ? '重新生成确认单' : '生成确认单'}
          </button>
        </div>
      )}
    </div>
  )
}
