/**
 * Douyu accounts. One is "当前使用" at a time: it is the one danmaku are sent from, the one
 * badge renewal reads, and the one a task needs to be able to start. Each keeps its own
 * login, signed in through a real Chrome window the viewer operates themselves.
 */

import { useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { DouyuAccountSummary } from '../../../server/douyu/types'
import { LaneLine } from './DouyuDesk'
import { accountState, type DouyuData } from './useDouyu'

export function Accounts({ data }: { data: DouyuData }): React.ReactNode {
  const { all, accounts, loading, accountLane, accountsBusy, accountAction } = data
  const [label, setLabel] = useState('')

  return (
    <div className="desk-pane">
      {!loading && all.length === 0 && <p className="desk-empty">暂无账号。填写名称并添加后即可登录。</p>}
      <ul className="account-list" aria-label="斗鱼账号">
        {all.map((account) => (
          <AccountRow key={account.id} account={account} active={account.id === accounts?.activeAccountId}
            locked={accountsBusy} data={data} />
        ))}
      </ul>

      <form className="add-row" onSubmit={(event) => {
        event.preventDefault()
        const name = label.trim()
        if (!name) return
        void accountAction('正在添加', () => apiClient.addDouyuAccount(name), `已添加 ${name}`).then((ok) => { if (ok) setLabel('') })
      }}>
        <input className="text-input" value={label} maxLength={40} placeholder="新账号名称，例如「小号」"
          aria-label="新账号名称" disabled={accountsBusy} onChange={(event) => setLabel(event.target.value)} />
        <button type="submit" className="btn-quiet" disabled={accountsBusy || !label.trim()}>添加账号</button>
      </form>

      <LaneLine lane={accountLane} />
    </div>
  )
}

function AccountRow({ account, active, locked, data }: {
  account: DouyuAccountSummary
  active: boolean
  locked: boolean
  data: DouyuData
}): React.ReactNode {
  const { accountAction } = data
  const [mode, setMode] = useState<'idle' | 'rename' | 'remove'>('idle')
  const [name, setName] = useState(account.label)

  const login = (): void => {
    void accountAction(`请在弹出的 Chrome 窗口中登录 ${account.label}，完成后关闭该窗口`,
      () => apiClient.loginDouyuAccount(account.id),
      (snapshot) => snapshot.accounts.find((item) => item.id === account.id)?.login.loggedIn
        ? `${account.label} 已登录` : `${account.label} 登录未完成，请重试`)
  }

  return (
    <li className="account" data-active={active} role="group" aria-label={`斗鱼账号 ${account.label}`}>
      <div className="account-main">
        {mode === 'rename' ? (
          <form className="inline-form" onSubmit={(event) => {
            event.preventDefault()
            const value = name.trim()
            if (!value) return
            void accountAction('正在重命名', () => apiClient.renameDouyuAccount(account.id, value), '已重命名').then((ok) => { if (ok) setMode('idle') })
          }}>
            <input className="text-input" value={name} autoFocus maxLength={40} aria-label="账号名称" onChange={(event) => setName(event.target.value)} />
            <button type="submit" className="btn-solid small" disabled={locked || !name.trim()}>保存</button>
            <button type="button" className="btn-quiet small" onClick={() => setMode('idle')}>取消</button>
          </form>
        ) : (
          <>
            <span className="account-name">{account.label}</span>
            {active && <span className="tag">当前使用</span>}
            <span className="muted">{accountState(account)}</span>
          </>
        )}
      </div>

      {mode === 'remove' ? (
        <div className="account-actions">
          <span className="note-warn">删除该账号及其任务？</span>
          <button type="button" className="btn-quiet small is-danger" disabled={locked}
            onClick={() => void accountAction('正在删除', () => apiClient.removeDouyuAccount(account.id), `已删除 ${account.label}`)}>删除</button>
          <button type="button" className="btn-quiet small" onClick={() => setMode('idle')}>取消</button>
        </div>
      ) : mode === 'idle' && (
        <div className="account-actions">
          {!active && (
            <button type="button" className="btn-quiet small" disabled={locked}
              onClick={() => void accountAction('正在切换', () => apiClient.activateDouyuAccount(account.id), `已切换到 ${account.label}`)}>
              设为当前
            </button>
          )}
          <button type="button" className={account.login.loggedIn ? 'btn-quiet small' : 'btn-solid small'} disabled={locked} onClick={login}>
            {account.login.loggedIn ? '重新登录' : '登录'}
          </button>
          <button type="button" className="btn-quiet small" disabled={locked}
            onClick={() => void accountAction(`请在弹出的 Chrome 窗口中登录 ${account.label} 的鱼吧，完成后关闭该窗口`,
              () => apiClient.loginDouyuYubaAccount(account.id), '鱼吧登录窗口已关闭')}>
            登录鱼吧
          </button>
          <button type="button" className="btn-quiet small" disabled={locked} onClick={() => { setName(account.label); setMode('rename') }}>重命名</button>
          <button type="button" className="btn-quiet small" disabled={locked || (!account.login.loggedIn && account.login.cookieCount === 0)}
            onClick={() => void accountAction('正在退出', () => apiClient.logoutDouyuAccount(account.id), `${account.label} 已退出`)}>
            退出
          </button>
          <button type="button" className="btn-quiet small is-danger" disabled={locked} onClick={() => setMode('remove')}>删除</button>
        </div>
      )}
    </li>
  )
}
