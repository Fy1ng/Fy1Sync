/**
 * Everything Douyu that is not watching: accounts, followed rooms, room tasks, batch
 * check-ins, the backpack and badges. It lives in 设置, off the player, on purpose: none of
 * it is touched mid-match.
 */

import { useSession, useSessionSnapshot } from '../../app/SessionContext'
import { Icon, SideTabs, type SideTabNavigation } from '../kit'
import type { LoginPlatform } from '../../../electron/login'
import { Accounts } from './Accounts'
import { Automations } from './Automations'
import { Backpack } from './Backpack'
import { Following } from './Following'
import { Renewal } from './Renewal'
import { Spending } from './Spending'
import { Tasks } from './Tasks'
import { accountName, useDouyu } from './useDouyu'
import { useAutomations } from './automationState'
import type { Lane } from './taskActions'
import { useRemembered } from '../../app/remembered'
import { DouyuWritesPane, useDouyuWrites } from '../douyuWrites'
import { ErrorText } from '../../ui/ErrorDetails'

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
export function DouyuDesk({ onWatch, platformNavigation, accountAside }: {
  onWatch: (room: string) => void
  platformNavigation?: SideTabNavigation<LoginPlatform>
  accountAside?: React.ReactNode
}): React.ReactNode {
  const session = useSession()
  const data = useDouyu(() => session.snapshot.settings.douyuWrites)
  const { danmaku } = useSessionSnapshot()
  // Back on the page last open; a first visit starts on 账号, as before.
  const [remembered, setTab] = useRemembered<Tab>('douyu:tab', 'accounts')
  const writes = useDouyuWrites()
  const shown = !writes && WRITE_TABS.has(remembered) ? 'accounts' : remembered
  const automations = useAutomations(shown === 'automations')
  const active = data.active
  const room = danmaku.room?.startsWith('huya:') ? null : danmaku.room

  return (
    <SideTabs label="斗鱼" value={shown} onChange={setTab} parentNavigation={platformNavigation}
      tabs={TABS.filter((item) => writes || !WRITE_TABS.has(item.id)).map((item) => ({
        ...item,
        badge: item.id === 'tasks' && data.tasks && data.tasks.tasks.length > 0
          ? <span className="num tab-count">{data.tasks.tasks.length}</span> : undefined,
      }))}
      aside={accountAside ?? <span className="desk-who">
        {!active ? '未设置当前账号' : accountName(active)
          ? <>当前账号<b>{accountName(active)}</b>{active.login.loggedIn ? '' : '（未登录）'}</>
          : active.login.loggedIn ? '已登录' : '未登录'}
      </span>}>
        <div className="desk-content">
          {shown === 'accounts' && <><Accounts data={data} /><Spending data={data} /></>}
          {shown === 'following' && <Following data={data} onWatch={onWatch} />}
          {shown === 'tasks' && <Tasks data={data} defaultRoom={room} />}
          {shown === 'automations' && <Automations data={data} state={automations} />}
          {shown === 'backpack' && <Backpack data={data} room={room} canGive={writes} />}
          {shown === 'renewal' && (
            <Renewal accountId={active?.id ?? null} accountLabel={active?.label ?? ''}
              ready={!!active?.login.loggedIn && !data.accountsBusy} />
          )}
          {shown === 'experimental' && <DouyuWritesPane />}
        </div>
    </SideTabs>
  )
}

/** Progress, outcome or failure for a pane or a task row. */
export function LaneLine({ lane, onDismiss }: { lane: Lane; onDismiss?: () => void }): React.ReactNode {
  if (lane.error) return <p className="form-error" role="alert">
    <ErrorText error={lane.errorDetail ?? lane.error} message={lane.error} />
    {onDismiss && <button type="button" className="btn-quiet small" aria-label="关闭提示" title="关闭提示" onClick={onDismiss}><Icon name="close" /></button>}
  </p>
  if (lane.pending || lane.notice) return <p className="lane" role="status">{lane.pending || lane.notice}</p>
  return null
}

export function TaskFormButtons({ disabled, onCancel }: { disabled: boolean; onCancel: () => void }): React.ReactNode {
  return <div className="row-end">
    <button type="button" className="btn-quiet" onClick={onCancel}>取消</button>
    <button type="submit" className="btn-solid" disabled={disabled}>添加并启动</button>
    <button type="submit" className="btn-quiet" value="add-only" disabled={disabled}>仅添加</button>
  </div>
}

export function startsOnSubmit(event: React.FormEvent<HTMLFormElement>): boolean {
  event.preventDefault()
  return (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') !== 'add-only'
}
