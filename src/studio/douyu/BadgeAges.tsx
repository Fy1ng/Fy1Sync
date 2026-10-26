/**
 * When each fan badge was acquired and how long it has been held (handoff item 76). The
 * list covers only the page the platform returned; a missing date stays 未知 rather than a
 * guess, and none of this says whether a badge is currently active.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { DouyuBadgeAges } from '../../../server/douyu/insightsTypes'
import { UNKNOWN, dateOnly, dateTime } from './giftFormat'
import './backpack.css'

const agesOk = (value: unknown, accountId: string): value is DouyuBadgeAges => {
  const ages = value as DouyuBadgeAges | null
  return !!ages && ages.accountId === accountId && Array.isArray(ages.badges)
}

export function BadgeAges({ accountId, ready }: { accountId: string | null; ready: boolean }): React.ReactNode {
  const [ages, setAges] = useState<DouyuBadgeAges | null>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const generation = useRef(0)
  const owner = useRef(accountId)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++ }
  }, [])

  useLayoutEffect(() => {
    if (owner.current === accountId) return
    owner.current = accountId
    generation.current++
    setAges(null); setReading(false); setError('')
  }, [accountId])

  const read = async (): Promise<void> => {
    if (!accountId || !ready || reading) return
    const mine = ++generation.current
    const asked = accountId
    setReading(true); setError('')
    try {
      const response = await apiClient.feature('getDouyuBadgeAges', { accountId: asked })
      if (!mounted.current || mine !== generation.current) return
      if (!response.ok) { setError(response.message); return }
      if (!agesOk(response.value, asked)) throw new Error('bad ages')
      setAges(response.value)
    } catch {
      if (mounted.current && mine === generation.current) setError('粉丝牌获取日期读取失败，请重试。')
    } finally {
      if (mounted.current && mine === generation.current) setReading(false)
    }
  }

  if (!accountId) return null

  return (
    <section className="badge-ages" aria-label="粉丝牌获取日期">
      <div className="step-head">
        <h3>获取日期与持有天数</h3>
        <button type="button" className="btn-quiet small" disabled={!ready || reading} onClick={() => void read()}>
          {reading ? '读取中…' : ages ? '重新读取' : '读取'}
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {ages && (
        <>
          {ages.badges.length === 0 ? <p className="muted">返回页面中没有粉丝牌。</p> : (
            <div className="pack-scroll">
              <table className="pack-table">
                <thead><tr><th>房间</th><th>牌名</th><th>获取日期</th><th>持有天数</th></tr></thead>
                <tbody>
                  {ages.badges.map((badge) => (
                    <tr key={badge.room}>
                      <td className="num">{badge.room}</td>
                      <td>{badge.badgeName || UNKNOWN}</td>
                      <td className="num">{dateOnly(badge.acquiredAt)}</td>
                      <td className="num">{typeof badge.heldDays === 'number' ? `${badge.heldDays} 天` : UNKNOWN}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted">
            来源为官方返回的粉丝牌页面，读取于 {dateTime(ages.checkedAt)}。仅包含本次返回的一页，可能不完整；
            未返回日期的显示为未知。持有天数不代表粉丝牌当前有效。
          </p>
        </>
      )}
    </section>
  )
}
