/**
 * The fixed confirmation page for a gift plan, the one button that executes it, and the
 * outcome. Everything shown comes from the plan the main process returned, not from the
 * form above it, so what is confirmed is exactly what will run.
 */

import type { DouyuGiftMoney, DouyuGiftResult, DouyuInventoryItem } from '../../../server/douyu/inventoryTypes'
import { GIFT_RESULT, type GiftPlanHandle } from './giftPlan'
import { UNKNOWN, dateTime, expiry, money, moneyBasis, secondsLeft, validMoney } from './giftFormat'
import './backpack.css'

const ROW_STATE: Record<DouyuGiftResult['rows'][number]['status'], string> = {
  'receipt-received': '已收到回执', 'not-submitted': '未提交', unknown: '结果未知',
}
const REASON: Record<NonNullable<DouyuGiftResult['reason']>, string> = {
  'plan-changed': '计划已变化',
  'inventory-changed': '库存已变化',
  'balance-changed': '余额未知、不足或已变化',
  'price-changed': '价格或可赠状态已变化',
  'account-changed': '账号或房间已变化',
  unconfirmed: '结果未能确认',
  cancelled: '已按要求停止',
  'queue-busy': '执行队列繁忙，未送出',
  unavailable: '当前条件不满足',
}

/** Known amounts summed per currency; unknown ones counted, never added as zero. */
function sumByCurrency(values: (DouyuGiftMoney | null)[]): { known: DouyuGiftMoney[]; unknown: number } {
  const known = new Map<DouyuGiftMoney['currency'], DouyuGiftMoney>()
  let unknown = 0
  for (const value of values) {
    if (!validMoney(value)) { unknown++; continue }
    const before = known.get(value.currency)
    known.set(value.currency, { ...value, amountMinor: (before?.amountMinor ?? 0) + value.amountMinor })
  }
  return { known: [...known.values()], unknown }
}

function Basis({ value }: { value: DouyuGiftMoney | null }): React.ReactNode {
  const basis = moneyBasis(value)
  return <>{money(value)}{basis && <span className="muted gift-basis">（{basis}）</span>}</>
}

export function GiftPlanView({ gift, accountLabel, currentRoom, ready, inventory }: {
  gift: GiftPlanHandle
  accountLabel: string
  currentRoom: string | null
  ready: boolean
  inventory: DouyuInventoryItem[] | null
}): React.ReactNode {
  const { plan, used, result, busy, stopping, error, expired, now } = gift
  if (!plan && !result && !error) return null

  const canGive = ready && !!plan && !used && !expired && plan.totalQuantity > 0 && !busy
  const purchase = plan?.kind === 'purchase'
  const row = plan?.rows[0]
  const rowExpiry = (propId: string | null, expiresAt: number | null): string => {
    if (typeof expiresAt === 'number') return dateTime(expiresAt)
    const item = inventory?.find((entry) => entry.propId === propId)
    return item ? expiry(item.expiration) : UNKNOWN
  }
  const value = plan && !purchase ? sumByCurrency(plan.rows.map((entry) => entry.total)) : null
  const unknownRows = result?.rows.filter((entry) => entry.status === 'unknown').length ?? 0

  return (
    <div className="gift-confirm">
      {plan && (
        <section aria-label="赠送确认单" className="plan gift-plan">
          <h4>{purchase ? '购买并赠送确认单' : '背包赠送确认单'}</h4>
          <dl className="gift-facts">
            <dt>账号</dt><dd>{accountLabel}</dd>
            <dt>目标</dt><dd className="num">房间 {plan.room}{currentRoom === plan.room ? <span className="muted">（当前直播间）</span> : null}</dd>
            {purchase && row ? (
              <>
                <dt>礼物</dt><dd>{row.name} <span className="muted num">ID {row.giftId ?? UNKNOWN}</span></dd>
                <dt>每次数量</dt><dd className="num">{row.quantity}</dd>
                <dt>次数</dt><dd className="num">{plan.repeat}</dd>
                <dt>总量</dt><dd className="num">{plan.totalQuantity}</dd>
                <dt>间隔</dt><dd className="num">{plan.intervalMs} 毫秒</dd>
                <dt>单价</dt><dd className="num"><Basis value={row.unitPrice} /></dd>
                <dt>预算</dt><dd className="num"><Basis value={plan.budget} /></dd>
                <dt>赠送前余额</dt><dd className="num"><Basis value={plan.balanceBefore} /></dd>
              </>
            ) : (
              <>
                <dt>道具总数</dt><dd className="num">{plan.totalQuantity}</dd>
                <dt>请求次数</dt><dd className="num">{plan.totalOperations}</dd>
                <dt>间隔</dt><dd className="num">{plan.intervalMs} 毫秒</dd>
                <dt>标称价值</dt>
                <dd className="num">
                  {value && value.known.length ? value.known.map(money).join('，') : '无已知价值'}
                  {value && value.unknown > 0 && <span className="muted">；价值未知 {value.unknown} 项</span>}
                </dd>
              </>
            )}
            <dt>确认单有效期</dt>
            <dd className="num">
              {dateTime(plan.expiresAt)}
              {!used && (expired ? <span className="form-error">　已过期，请重新生成</span> : <span className="muted">　剩余 {secondsLeft(plan.expiresAt, now)} 秒</span>)}
            </dd>
          </dl>

          {!purchase && (
            <table className="pack-table">
              <thead><tr><th>道具</th><th>每次数量</th><th>请求次数</th><th>库存</th><th>到期</th><th>标称价值</th></tr></thead>
              <tbody>
                {plan.rows.map((entry) => (
                  <tr key={entry.propId ?? entry.name}>
                    <td>{entry.name} <span className="muted num">{entry.propId}</span></td>
                    <td className="num">{entry.quantity}</td>
                    <td className="num">{entry.repeat}</td>
                    <td className="num">{entry.stock ?? UNKNOWN}</td>
                    <td className="num">{rowExpiry(entry.propId, entry.expiresAt)}</td>
                    <td className="num">{money(entry.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="gift-excluded">
            <span className="muted">排除项</span>
            {plan.excludedItems.length === 0 ? <span className="muted">无</span> : (
              <ul>
                {plan.excludedItems.map((entry) => (
                  <li key={entry.propId}>{entry.name} × <span className="num">{entry.quantity}</span><span className="muted">　{entry.reason || '不符合赠送条件'}</span></li>
                ))}
              </ul>
            )}
          </div>
          {plan.message && <p className="muted">{plan.message}</p>}

          <div className="gift-actions">
            {/* The confirm button stays mounted and disabled while running, so the second
                click of a double click cannot land on 停止剩余 in its place. */}
            <button key="give" type="button" className="btn-solid small" disabled={!canGive} onClick={() => void gift.give()}>确认赠送</button>
            {busy === 'give' && (
              <button key="stop" type="button" className="btn-quiet small" disabled={stopping} onClick={() => void gift.stop()}>
                {stopping ? '正在停止…' : '停止剩余'}
              </button>
            )}
            {busy === 'give' && <span className="lane" role="status">正在赠送，结果返回前请勿关闭本页。</span>}
            {used && busy !== 'give' && <span className="muted">此确认单已使用。如需再次赠送，请重新生成。</span>}
          </div>
        </section>
      )}

      {result && (
        <section aria-label="赠送结果" className="plan gift-result">
          <p>
            <b>{GIFT_RESULT[result.status]}</b>
            {result.reason && <span className="muted">　{REASON[result.reason] ?? result.reason}</span>}
          </p>
          <p className="num">已提交 {result.submittedQuantity} · 已收到回执 {result.confirmedQuantity}</p>
          {result.rows.length > 0 && (
            <ul className="plan-rows">
              {result.rows.map((entry, index) => (
                <li key={`${entry.propId ?? entry.giftId ?? entry.name}-${entry.repetition}-${index}`} data-state={entry.status}>
                  <span>{entry.name} × <span className="num">{entry.quantity}</span><span className="muted num">　第 {entry.repetition} 次</span></span>
                  <span>{ROW_STATE[entry.status] ?? UNKNOWN}{entry.message && <span className="muted"> {entry.message}</span>}</span>
                </li>
              ))}
            </ul>
          )}
          {unknownRows > 0 && <p className="note-warn">{unknownRows} 项结果未知，请在官方直播间核对。此处不会自动重新赠送。</p>}
          {result.message && <p className="muted">{result.message}</p>}
          <p className="muted">收到回执不代表平台已完成全部处理；停止不会撤回已赠出的礼物。</p>
        </section>
      )}

      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  )
}
