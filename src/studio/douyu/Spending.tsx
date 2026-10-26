/**
 * This month's spending for the current account (handoff item 77).
 *
 * Each ledger the platform offers is shown on its own, with how much of it was read. A
 * total is only shown when the main process could prove one; adding the ledgers here would
 * double count whatever they share, so a missing total says why instead. Reading is on
 * request: it pages through the account's ledgers and the accounts tab opens often.
 */

import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { DouyuMonthlySpending, DouyuSpendSource } from '../../../server/douyu/insightsTypes'
import { Icon } from '../kit'
import { formatMinor, formatTime } from '../insights/format'
import type { DouyuData } from './useDouyu'
import './spending.css'

const SOURCE_NAME: Record<DouyuSpendSource['source'], string> = {
  'gift-consumption': '礼物消费记录',
  'diamond-fans': '钻粉充值记录',
}

const AGGREGATION_REASON: Record<DouyuMonthlySpending['aggregation'], string> = {
  complete: '合计不可用。',
  partial: '部分来源未能完整读取，不计算合计。',
  unreconciled: '各来源之间无法核验是否重复记账，不将其相加作为合计。',
}

const yuan = (minor: number | null): string => {
  const text = formatMinor(minor)
  return minor === null || text === '未知' ? text : `${text} 元`
}

const validSpending = (value: unknown): value is DouyuMonthlySpending =>
  !!value && Array.isArray((value as DouyuMonthlySpending).sources)

export function Spending({ data }: { data: DouyuData }): React.ReactNode {
  const account = data.active
  const accountId = account?.id ?? null
  const ready = !!account?.login.loggedIn
  const [spending, setSpending] = useState<DouyuMonthlySpending | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)

  // A different or signed-out account invalidates what was shown and anything in flight.
  useEffect(() => {
    generation.current++
    setSpending(null)
    setError('')
    setLoading(false)
    return () => { generation.current++ }
  }, [accountId, ready])

  const read = (): void => {
    if (!accountId || !ready) return
    const mine = ++generation.current
    setLoading(true)
    setError('')
    void apiClient.feature('getDouyuMonthlySpending', { accountId }).then((result) => {
      if (mine !== generation.current) return
      setLoading(false)
      if (!result.ok) { setError(result.message); return }
      if (!validSpending(result.value) || result.value.accountId !== accountId) { setError('无法读取本月消费'); return }
      setSpending(result.value)
    })
  }

  return (
    <section className="desk-pane spending" aria-label="本月消费">
      <div className="row-split">
        <h3 className="spending-title">
          本月消费
          {spending && <span className="muted num"> {spending.month}（北京时间）</span>}
        </h3>
        <button type="button" className="btn-quiet small" disabled={!ready || loading} onClick={read}>
          <Icon name="refresh" />{spending ? '刷新' : '读取'}
        </button>
      </div>

      {!account && <p className="lane">未设置当前账号，无法读取消费记录。</p>}
      {account && !ready && <p className="lane">当前账号未登录，无法读取消费记录。</p>}
      {loading && <p className="lane" role="status">正在读取本月消费</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      {spending && (
        <>
          <div className="spending-total" role="group" aria-label="本月合计">
            <span className="muted">合计</span>
            {spending.totalMinor !== null
              ? <b className="num">{yuan(spending.totalMinor)}</b>
              : <span className="spending-missing">{AGGREGATION_REASON[spending.aggregation]}</span>}
          </div>
          {spending.message && <p className="lane">{spending.message}</p>}
          {spending.sources.length === 0 && <p className="lane">未返回任何消费来源。</p>}
          {spending.sources.map((source) => <SourceBlock key={source.source} source={source} />)}
          <p className="lane">金额单位为元，按斗鱼返回的分值换算；更新于 {formatTime(spending.checkedAt)}</p>
        </>
      )}
    </section>
  )
}

function SourceBlock({ source }: { source: DouyuSpendSource }): React.ReactNode {
  const name = SOURCE_NAME[source.source] ?? source.source
  const complete = source.coverage === 'all-pages'
  return (
    <div className="spending-source" role="group" aria-label={name}>
      <div className="row-split">
        <span className="spending-name">{name}</span>
        <span className="num">{yuan(source.amountMinor)}{complete ? '' : '（已读取部分）'}</span>
      </div>
      <p className={complete ? 'lane' : 'spending-partial'}>
        {complete ? '已读取全部' : '仅读取部分'} {source.pageCount} 页，共 {source.entries} 笔
        {source.reason ? `。${source.reason}` : ''}
      </p>
      {source.categories.length > 0 && (
        <table className="spending-table">
          <thead>
            <tr><th scope="col">分类</th><th scope="col">笔数</th><th scope="col">金额</th></tr>
          </thead>
          <tbody>
            {source.categories.map((category) => (
              <tr key={category.category}>
                <td>{category.category}</td>
                <td className="num">{category.entries}</td>
                <td className="num">{yuan(category.amountMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
