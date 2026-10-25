/**
 * Everything Douyu that is not watching: accounts, room tasks, badge renewal. It lives off
 * the player on purpose — none of it is touched mid-match.
 */

import { useState } from 'react'
import { useSessionSnapshot } from '../../app/SessionContext'
import { Sheet } from '../kit'
import { Accounts } from './Accounts'
import { Renewal } from './Renewal'
import { Tasks } from './Tasks'
import { useDouyu, type Lane } from './useDouyu'

type Tab = 'accounts' | 'tasks' | 'renewal'
const TABS: { id: Tab; label: string }[] = [
  { id: 'accounts', label: '账号' },
  { id: 'tasks', label: '房间任务' },
  { id: 'renewal', label: '续粉丝牌' },
]

export function DouyuDesk({ onClose }: { onClose: () => void }): React.ReactNode {
  const data = useDouyu()
  const { danmaku } = useSessionSnapshot()
  const [tab, setTab] = useState<Tab>(data.all.length === 0 ? 'accounts' : 'tasks')
  const active = data.active

  return (
    <Sheet title="斗鱼" onClose={onClose} wide>
      <div className="desk">
        <nav className="desk-tabs" role="tablist" aria-label="斗鱼">
          {TABS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
              className={tab === item.id ? 'is-on' : undefined} onClick={() => setTab(item.id)}>
              {item.label}
              {item.id === 'tasks' && data.tasks && data.tasks.tasks.length > 0 && <span className="num tab-count">{data.tasks.tasks.length}</span>}
            </button>
          ))}
          <span className="desk-who">
            {active ? <>当前账号 <b>{active.label}</b>{active.login.loggedIn ? '' : '（未登录）'}</> : '未设置当前账号'}
          </span>
        </nav>
        <div className="desk-content" role="tabpanel">
          {tab === 'accounts' && <Accounts data={data} />}
          {tab === 'tasks' && <Tasks data={data} defaultRoom={danmaku.room} />}
          {tab === 'renewal' && (
            <Renewal accountId={active?.id ?? null} accountLabel={active?.label ?? ''}
              ready={!!active?.login.loggedIn && !data.accountsBusy} />
          )}
        </div>
      </div>
    </Sheet>
  )
}

/** The one line of feedback under a pane: what is happening, what happened, or what failed. */
export function LaneLine({ lane }: { lane: Lane }): React.ReactNode {
  if (lane.error) return <p className="form-error" role="alert">{lane.error}</p>
  if (lane.pending || lane.notice) return <p className="lane" role="status">{lane.pending || lane.notice}</p>
  return null
}
