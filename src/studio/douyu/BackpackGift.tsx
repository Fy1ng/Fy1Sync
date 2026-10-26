/**
 * Choosing what to give from the backpack (handoff items 54 and 55): either explicit
 * items and whole quantities no larger than the stock just read, or every item the main
 * process marks giftable in its own fresh read. Any change here retires the preview.
 */

import { useEffect, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { DouyuGiftPlan, DouyuInventorySnapshot } from '../../../server/douyu/inventoryTypes'
import { Segmented } from '../kit'
import { planShapeOk, type GiftPlanHandle } from './giftPlan'
import { expiry, roomOk, wholeIn } from './giftFormat'
import './backpack.css'

type Source = 'pick' | 'all'
const MAX_OPERATIONS = 10_000
const MAX_SPAN_MS = 86_400_000

export function BackpackGift({ accountId, room, inventory, gift, locked }: {
  accountId: string
  room: string
  inventory: DouyuInventorySnapshot | null
  gift: GiftPlanHandle
  locked: boolean
}): React.ReactNode {
  const [source, setSource] = useState<Source>('pick')
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [gap, setGap] = useState('1000')

  const giftable = inventory?.items.filter((item) => item.canGift && item.quantity > 0) ?? []

  // A fresh read can drop items; a pick for an item that is gone is not a selection.
  useEffect(() => {
    const ids = new Set(inventory?.items.filter((item) => item.canGift).map((item) => item.propId) ?? [])
    setPicks((current) => {
      const kept = Object.fromEntries(Object.entries(current).filter(([propId]) => ids.has(propId)))
      return Object.keys(kept).length === Object.keys(current).length ? current : kept
    })
  }, [inventory])

  const intervalMs = wholeIn(gap, 0, 60_000)
  const chosen = giftable.filter((item) => (picks[item.propId] ?? '') !== '')
  const badPick = chosen.some((item) => wholeIn(picks[item.propId]!, 1, item.quantity) === null)
  const selection = chosen.map((item) => ({ propId: item.propId, quantity: wholeIn(picks[item.propId]!, 1, item.quantity) ?? 0 }))
  const operations = chosen.reduce((sum, item) => sum + (item.batchSupported ? 1 : wholeIn(picks[item.propId]!, 1, item.quantity) ?? 0), 0)
  const tooLong = source === 'pick' && intervalMs !== null && (operations > MAX_OPERATIONS || operations * intervalMs > MAX_SPAN_MS)
  const formOk = roomOk(room) && intervalMs !== null && (source === 'all' || (chosen.length > 0 && !badPick && !tooLong))

  const edit = (apply: () => void): void => { if (locked) return; gift.discard(); apply() }

  const preview = (): void => {
    if (!formOk || intervalMs === null || locked) return
    const asked = source === 'all' ? 'all' as const : selection
    const accepts = (value: unknown): value is DouyuGiftPlan => {
      if (!planShapeOk(value, accountId, room, 'inventory') || value.intervalMs !== intervalMs) return false
      if (value.rows.some((row) => typeof row.propId !== 'string')) return false
      if (asked === 'all') return true
      // The plan must give exactly what was picked, item by item.
      return value.rows.length === asked.length && asked.every((pick) => {
        const row = value.rows.find((entry) => entry.propId === pick.propId)
        return !!row && row.quantity * row.repeat === pick.quantity
      })
    }
    void gift.preview(
      () => apiClient.feature('previewDouyuInventoryGift', { accountId, input: { room, selection: asked, intervalMs } }),
      accepts,
    )
  }

  return (
    <div className="gift-form">
      <div className="gift-line">
        <Segmented<Source> label="赠送范围" value={source} disabled={locked}
          options={[{ value: 'pick', label: '指定道具' }, { value: 'all', label: '全部可赠道具' }]}
          onChange={(value) => edit(() => setSource(value))} />
        <label className="gift-field">
          <span>间隔</span>
          <input className="text-input num" inputMode="numeric" value={gap} disabled={locked} aria-label="赠送间隔（毫秒）"
            aria-invalid={intervalMs === null} onChange={(event) => { const next = event.target.value; edit(() => setGap(next)) }} />
          <span>毫秒</span>
        </label>
      </div>
      {intervalMs === null && <p className="form-error">间隔请填写 0 到 60000 的整数</p>}

      {source === 'all' ? (
        <p className="muted">按主进程本次读取的可赠库存全部赠送给目标房间。已过期、不支持或状态未知的道具列入排除项，背包不一定因此清空。</p>
      ) : !inventory ? (
        <p className="muted">读取库存后可选择道具。</p>
      ) : giftable.length === 0 ? (
        <p className="muted">当前库存中没有可赠道具。</p>
      ) : (
        <ul className="gift-picks">
          {giftable.map((item) => {
            const text = picks[item.propId] ?? ''
            const bad = text !== '' && wholeIn(text, 1, item.quantity) === null
            return (
              <li key={item.propId} data-on={text !== ''}>
                <span className="gift-pick-name">{item.name} <span className="muted num">{item.propId}</span></span>
                <span className="muted num">库存 {item.quantity} · {expiry(item.expiration)}</span>
                <input className="text-input num gift-qty" inputMode="numeric" value={text} placeholder="0" disabled={locked}
                  aria-label={`${item.name} 赠送数量`} aria-invalid={bad}
                  onChange={(event) => {
                    const next = event.target.value
                    edit(() => setPicks((current) => {
                      const copy = { ...current }
                      if (next === '' || next === '0') delete copy[item.propId]
                      else copy[item.propId] = next
                      return copy
                    }))
                  }} />
              </li>
            )
          })}
        </ul>
      )}
      {source === 'pick' && badPick && <p className="form-error">数量须为 1 到当前库存之间的整数</p>}
      {tooLong && <p className="form-error">请求次数或总时长超出上限（{MAX_OPERATIONS} 次，24 小时），请减少数量或间隔</p>}
      {!roomOk(room) && <p className="form-error">请填写有效的目标房间号</p>}

      <div className="gift-actions">
        <button type="button" className={gift.plan ? 'btn-quiet small' : 'btn-solid small'}
          disabled={!formOk || locked || !!gift.busy} onClick={preview}>
          {gift.busy === 'plan' ? '生成中…' : gift.plan ? '重新生成预览' : '生成预览'}
        </button>
      </div>
    </div>
  )
}
