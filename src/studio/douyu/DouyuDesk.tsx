/**
 * Everything Douyu that is not watching: accounts, followed rooms, room tasks, batch
 * check-ins, the backpack and badges. It lives in 设置, off the player, on purpose: none of
 * it is touched mid-match.
 */

import { useSessionSnapshot } from '../../app/SessionContext'
import { SideTabs } from '../kit'
import { Accounts } from './Accounts'
import { Automations } from './Automations'
import { Backpack } from './Backpack'
import { Following } from './Following'
import { Renewal } from './Renewal'
import { Spending } from './Spending'
import { Tasks } from './Tasks'
import { useDouyu, type Lane } from './useDouyu'
import { useRemembered } from '../../app/remembered'
import { DouyuWritesPane, useDouyuWrites } from '../douyuWrites'

type Tab = 'accounts' | 'following' | 'tasks' | 'automations' | 'backpack' | 'renewal' | 'experimental'
/** Pages that only write to Douyu; hidden until 斗鱼写操作 is on. */
const WRITE_TABS: ReadonlySet<Tab> = new Set(['tasks', 'automations', 'renewal'])
const TABS: { id: Tab; label: string }[] = [
  { id: 'accounts', label: '账号' },
  { id: 'following', label: '关注' },
  { id: 'tasks', label: '房间任务' },
  { id: 'automations', label: '批量任务' },
  { id: 'backpack', label: '背包' },
  { id: 'renewal', label: '粉丝牌' },
  { id: 'experimental', label: '实验性' },
]

/** The Douyu section of 设置. `onWatch` loads a followed room as the commentary. */
export function DouyuDesk({ onWatch }: { onWatch: (room: string) => void }): React.ReactNode {
  const data = useDouyu()
  const { danmaku } = useSessionSnapshot()
  // Back on the page last open; a first visit starts on 账号, as before.
  const [remembered, setTab] = useRemembered<Tab>('douyu:tab', 'accounts')
  const writes = useDouyuWrites()
  const shown = !writes && WRITE_TABS.has(remembered) ? 'accounts' : remembered
  const active = data.active

  return (
    <SideTabs label="斗鱼" value={shown} onChange={setTab}
      tabs={TABS.filter((item) => writes || !WRITE_TABS.has(item.id)).map((item) => ({
        ...item,
        badge: item.id === 'tasks' && data.tasks && data.tasks.tasks.length > 0
          ? <span className="num tab-count">{data.tasks.tasks.length}</span> : undefined,
      }))}
      aside={<span className="desk-who">
        {active ? <>当前账号<b>{active.label}</b>{active.login.loggedIn ? '' : '（未登录）'}</> : '未设置当前账号'}
      </span>}>
        <div className="desk-content">
          {shown === 'accounts' && <><Accounts data={data} /><Spending data={data} /></>}
          {shown === 'following' && <Following data={data} onWatch={onWatch} />}
          {shown === 'tasks' && <Tasks data={data} defaultRoom={danmaku.room} />}
          {shown === 'automations' && <Automations data={data} />}
          {shown === 'backpack' && <Backpack data={data} room={danmaku.room} canGive={writes} />}
          {shown === 'renewal' && (
            <Renewal accountId={active?.id ?? null} accountLabel={active?.label ?? ''}
              ready={!!active?.login.loggedIn && !data.accountsBusy} />
          )}
          {shown === 'experimental' && <DouyuWritesPane />}
        </div>
    </SideTabs>
  )
}

/** The one line of feedback under a pane: what is happening, what happened, or what failed. */
export function LaneLine({ lane }: { lane: Lane }): React.ReactNode {
  if (lane.error) return <p className="form-error" role="alert">{lane.error}</p>
  if (lane.pending || lane.notice) return <p className="lane" role="status">{lane.pending || lane.notice}</p>
  return null
}
