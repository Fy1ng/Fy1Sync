/**
 * The shared activity settings behind 钓鱼 and 开宝箱 tasks. They are app-wide, not per
 * task, and the main process only accepts the whole object, so every change sends all
 * of it, built from the last value the main process confirmed.
 */

import { useEffect, useRef, useState } from 'react'
import { ErrorText, useErrorState } from '../../ui/ErrorDetails'
import { displayError } from '../../core/errorDetails'
import { apiClient } from '../../app/apiClient'
import type { ActivityPreferences } from '../../../electron/activityPreferences'
import { Segmented, Switch } from '../kit'
import { formatMsAsSeconds, parseSecondsToMs, SECONDS_INPUT_ERROR } from './durationSeconds'

type Full = { version: 1; fishing: { mode: 'all' | 'contest' }; treasure: { crossRoom: boolean; claimDelayMs: number } }

const normalize = (value: ActivityPreferences): Full => ({
  version: 1,
  fishing: { mode: value.fishing?.mode === 'contest' ? 'contest' : 'all' },
  treasure: {
    crossRoom: value.treasure?.crossRoom === true,
    claimDelayMs: Number.isSafeInteger(value.treasure?.claimDelayMs) ? value.treasure.claimDelayMs! : 5_000,
  },
})
export function ActivityOptions({ fishing, treasure }: { fishing: boolean; treasure: boolean }): React.ReactNode {
  const [value, setValue] = useState<Full | null>(null)
  const [delay, setDelay] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError, errorDetail] = useErrorState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void apiClient.feature('getDouyuActivityOptions', undefined).then((result) => {
      if (!mounted.current) return
      if (!result.ok) { setError(result); return }
      const full = normalize(result.value)
      setValue(full); setDelay(formatMsAsSeconds(full.treasure.claimDelayMs))
    }).catch(caught => { if (mounted.current) setError(displayError(caught, '无法读取活动设置')) })
    return () => { mounted.current = false }
  }, [])

  const save = async (next: Full): Promise<void> => {
    if (saving) return
    setSaving(true); setError(''); setNotice('')
    try {
      const result = await apiClient.feature('setDouyuActivityOptions', next)
      if (!mounted.current) return
      if (!result.ok) { setError(result); return }
      const full = normalize(result.value)
      setValue(full); setDelay(formatMsAsSeconds(full.treasure.claimDelayMs)); setNotice('活动设置已保存')
    } catch (caught) {
      if (mounted.current) setError(displayError(caught, '活动设置未保存，请重试'))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const parsedDelay = parseSecondsToMs(delay)
  const delayChanged = value !== null && parsedDelay !== value.treasure.claimDelayMs
  const saveDelay = (): void => {
    if (value && parsedDelay !== null && delayChanged) void save({ ...value, treasure: { ...value.treasure, claimDelayMs: parsedDelay } })
  }

  return (
    <section className="task-activity" aria-label="活动设置">
      <h4 className="field-label">活动设置（适用于全部同类任务）</h4>
      {!value && !error && <p className="muted">正在读取</p>}
      {value && fishing && (
        <div className="field-stack">
          <span className="field-label">钓鱼时段</span>
          <Segmented label="钓鱼时段" value={value.fishing.mode} disabled={saving}
            onChange={(mode) => void save({ ...value, fishing: { mode } })}
            options={[{ value: 'all', label: '全天' }, { value: 'contest', label: '仅大赛时段' }]} />
          <p className="muted">大赛时段仅限制开始新一轮，已开始的钓鱼仍会收杆</p>
        </div>
      )}
      {value && treasure && (
        <div className="field-stack">
          <Switch label="跨房间领取宝箱" detail="仅支持普通宝箱" checked={value.treasure.crossRoom} disabled={saving}
            onChange={(crossRoom) => void save({ ...value, treasure: { ...value.treasure, crossRoom } })} />
          {/* Not a <form>: this panel also sits inside the new-task form. */}
          <div className="task-activity-delay">
            <label className="field-stack">
              <span className="field-label">开启后延迟（秒，0 至 60）</span>
              <input className="text-input num" inputMode="decimal" value={delay} disabled={saving}
                aria-label="宝箱领取延迟（秒）" aria-invalid={parsedDelay === null} onChange={(event) => setDelay(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveDelay() } }} />
            </label>
            <button type="button" className="btn-quiet small" disabled={saving || parsedDelay === null || !delayChanged}
              onClick={saveDelay}>保存延迟</button>
          </div>
          {parsedDelay === null && <p className="form-error"><ErrorText error={SECONDS_INPUT_ERROR} message={SECONDS_INPUT_ERROR} /></p>}
        </div>
      )}
      {error && <p className="form-error" role="alert"><ErrorText error={errorDetail ?? error} message={error} /></p>}
      {!error && notice && <p className="lane" role="status">{notice}</p>}
    </section>
  )
}
