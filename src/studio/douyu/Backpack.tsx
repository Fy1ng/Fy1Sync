/**
 * The current account's backpack and the two ways of gifting from this page (handoff items
 * 53-56): giving items already in the backpack, and buying a current gift to send.
 *
 * Reading never gives. Gifting always goes through one fixed confirmation page built by the
 * main process and an explicit confirm; changing the account, room, mode, items, numbers or
 * interval throws that page away. Unknown values stay unknown: no price, intimacy or expiry
 * is ever shown as 0 or 永久 because it was missing.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { DouyuInventorySnapshot } from '../../../server/douyu/inventoryTypes'
import { Segmented } from '../kit'
import { BackpackGift } from './BackpackGift'
import { GiftPlanView } from './GiftPlanView'
import { GiftPurchase } from './GiftPurchase'
import { useGiftPlan } from './giftPlan'
import { UNKNOWN, dateTime, expiry, money, roomOk } from './giftFormat'
import type { DouyuData } from './useDouyu'
import './backpack.css'
import { useRemembered } from '../../app/remembered'

type Mode = 'inventory' | 'purchase'

const snapshotOk = (value: unknown, accountId: string): value is DouyuInventorySnapshot => {
  const snapshot = value as DouyuInventorySnapshot | null
  return !!snapshot && snapshot.accountId === accountId && Array.isArray(snapshot.items)
    && !!snapshot.totals && Array.isArray(snapshot.totals.knownValue)
}

export function Backpack({ data, room, canGive = true }: { data: DouyuData; room: string | null; canGive?: boolean }): React.ReactNode {
  const active = data.active
  const accountId = active?.id ?? null
  const loggedIn = !!active?.login.loggedIn
  const ready = loggedIn && !data.accountsBusy
  const currentRoom = data.tasks?.currentRoom ?? room ?? null

  const gift = useGiftPlan(accountId)
  const [roomText, setRoomText] = useState(room ?? '')
  // Per account: reopening shows the last backpack at once; it is read again on open as before.
  const [inventory, setInventory] = useRemembered<DouyuInventorySnapshot | null>(accountId ? `douyu:inventory:${accountId}` : null, null)
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState('')
  const [mode, setMode] = useState<Mode>('inventory')
  const edited = useRef(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const owner = useRef(accountId)
  const autoRead = useRef<string | null>(null)

  const locked = !ready || gift.busy === 'give'
  const { discard, reset } = gift

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++ }
  }, [])

  // A different account owns a different backpack: nothing read for the old one stays.
  useLayoutEffect(() => {
    if (owner.current === accountId) return
    owner.current = accountId
    generation.current++
    autoRead.current = null
    setReading(false); setReadError('')
  }, [accountId])

  // Signing out invalidates any plan made while signed in.
  useEffect(() => { if (!loggedIn) reset() }, [loggedIn, reset])

  // Follow the connected room until the viewer types their own.
  const shownRoom = useRef(roomText)
  shownRoom.current = roomText
  const giving = gift.busy === 'give'
  useEffect(() => {
    const next = room ?? ''
    if (edited.current || giving || shownRoom.current === next) return
    discard()
    setRoomText(next)
  }, [room, giving, discard])

  const load = async (): Promise<void> => {
    if (!accountId || !ready || gift.busy === 'give') return
    discard()
    const mine = ++generation.current
    const asked = accountId
    setReading(true); setReadError('')
    try {
      const response = await apiClient.feature('getDouyuInventory', { accountId: asked, ...(roomOk(roomText) ? { room: roomText } : {}) })
      if (!mounted.current || mine !== generation.current) return
      if (!response.ok) { setReadError(response.message); return }
      if (!snapshotOk(response.value, asked)) throw new Error('bad snapshot')
      setInventory(response.value)
    } catch {
      if (mounted.current && mine === generation.current) setReadError('背包读取失败，请重试。')
    } finally {
      if (mounted.current && mine === generation.current) setReading(false)
    }
  }

  // Reading is harmless, so the backpack is read once when the page opens for an account.
  useEffect(() => {
    if (!accountId || !ready || autoRead.current === accountId) return
    autoRead.current = accountId
    void load()
  }, [accountId, ready]) // load reads the latest room; it is not a trigger

  if (!active) return <div className="desk-pane"><p className="desk-empty">未设置当前账号。请在「账号」中设置。</p></div>
  if (!loggedIn) return <div className="desk-pane"><p className="desk-empty">当前账号未登录。请在「账号」中登录后使用背包。</p></div>

  const totals = inventory?.totals

  return (
    <div className="desk-pane backpack">
      <div className="pack-bar">
        <label className="gift-field">
          <span>目标房间</span>
          <input className="text-input num pack-room" inputMode="numeric" value={roomText} disabled={locked}
            aria-label="目标房间号" aria-invalid={roomText !== '' && !roomOk(roomText)}
            onChange={(event) => {
              if (locked) return
              edited.current = true
              discard()
              setRoomText(event.target.value.trim())
            }} />
        </label>
        <button type="button" className="btn-quiet small" disabled={!ready || reading || gift.busy === 'give'} onClick={() => void load()}>
          {reading ? '读取中…' : '刷新库存'}
        </button>
        <span className="muted">账号 <b>{active.label}</b></span>
      </div>
      {currentRoom && roomOk(roomText) && roomText !== currentRoom && (
        <p className="note-warn">当前直播间为 {currentRoom}。赠送仅对当前直播间有效，其他房间的预览将被拒绝。</p>
      )}
      {roomText === '' && <p className="muted">请填写目标房间号，或先连接直播间。</p>}

      <section aria-label="背包库存" className="pack-stock">
        {readError && <p className="form-error" role="alert">{readError}</p>}
        {!inventory ? (!readError && <p className="muted">{reading ? '正在读取背包…' : '尚未读取背包。'}</p>) : (
          <>
            <p className="muted num">房间 {inventory.room} · 读取于 {dateTime(inventory.checkedAt)}</p>
            {inventory.items.length === 0 ? <p className="muted">背包中没有道具。</p> : (
              <div className="pack-scroll">
                <table className="pack-table">
                  <thead>
                    <tr><th>道具</th><th>数量</th><th>到期</th><th>单价</th><th>总价值</th><th>亲密度</th><th>赠送</th></tr>
                  </thead>
                  <tbody>
                    {inventory.items.map((item) => (
                      <tr key={item.propId} data-off={!item.canGift}>
                        <td>{item.name} <span className="muted num">{item.propId}</span></td>
                        <td className="num">{item.quantity}</td>
                        <td className="num">{expiry(item.expiration)}</td>
                        <td className="num">{money(item.unitValue)}</td>
                        <td className="num">{money(item.totalValue)}</td>
                        <td className="num">{typeof item.intimacyTotal === 'number' ? item.intimacyTotal : UNKNOWN}</td>
                        <td>{item.canGift ? '可赠' : <span className="muted">{item.unavailableReason || '不可赠'}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {totals && (
              <dl className="pack-totals" aria-label="背包汇总">
                <div><dt>道具总数</dt><dd className="num">{totals.quantity}</dd></div>
                <div>
                  <dt>已知价值</dt>
                  <dd className="num">{totals.knownValue.length ? totals.knownValue.map(money).join('，') : '无'}</dd>
                </div>
                <div><dt>价值未知</dt><dd className="num">{totals.unvaluedItems} 项</dd></div>
                <div><dt>已知亲密度</dt><dd className="num">{totals.knownIntimacy}</dd></div>
                <div><dt>亲密度未知</dt><dd className="num">{totals.unknownIntimacyItems} 项</dd></div>
              </dl>
            )}
            {inventory.message && <p className="muted">{inventory.message}</p>}
          </>
        )}
      </section>

      {canGive && <section aria-label="赠送" className="pack-give">
        <div className="step-head">
          <h3>赠送</h3>
          <Segmented<Mode> label="赠送方式" value={mode} disabled={locked}
            options={[{ value: 'inventory', label: '背包道具' }, { value: 'purchase', label: '购买礼物' }]}
            onChange={(value) => { if (locked) return; discard(); setMode(value) }} />
        </div>
        {mode === 'inventory'
          ? <BackpackGift key={accountId} accountId={active.id} room={roomText} inventory={inventory} gift={gift} locked={locked} />
          : <GiftPurchase key={`${accountId}:${roomText}`} accountId={active.id} room={roomText} gift={gift} locked={locked} ready={ready} />}
        <GiftPlanView gift={gift} accountLabel={active.label} currentRoom={currentRoom} ready={ready} inventory={inventory?.items ?? null} />
      </section>}
    </div>
  )
}
