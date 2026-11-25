/**
 * Douyu accounts. One is "当前使用" at a time: it is the one danmaku are sent from, the one
 * badge renewal reads, and the one a task needs to be able to start. Each keeps its own
 * login, signed in through the official page inside the app's isolated login card.
 */

import { useState } from 'react'
import { displayError } from '../../core/errorDetails'
import { apiClient } from '../../app/apiClient'
import type { DouyuAccountSummary } from '../../../server/douyu/types'
import { LaneLine } from './DouyuDesk'
import { accountName, accountState, type DouyuData } from './useDouyu'
import { AccountAvatar, BrowserImportButton } from '../login/BrowserLoginImport'
import { ReadError } from '../ReadError'

export function Accounts({ data }: { data: DouyuData }): React.ReactNode {
  const { all, accounts, loading, accountsReadError, reloadAccounts, accountLane, accountsBusy, accountAction } = data

  return (
    <div className="desk-pane">
      {loading && <p className="muted" role="status">正在读取账号</p>}
      {accountsReadError && <ReadError error={accountsReadError} detail={data.accountsReadDetail} onRetry={() => void reloadAccounts()} />}
      {!loading && !accountsReadError && accounts && all.length === 0 && <p className="desk-empty">暂无账号</p>}
      <ul className="account-list" aria-label="斗鱼账号">
        {all.map((account) => (
          <AccountRow key={account.id} account={account} active={account.id === accounts?.activeAccountId}
            locked={accountsBusy} data={data} />
        ))}
      </ul>

      <div className="add-row">
        <button type="button" className="btn-quiet" disabled={accountsBusy}
          onClick={() => void accountAction('正在添加', () => apiClient.addDouyuAccount(), '已添加账号')}>
          添加账号
        </button>
      </div>

      <LaneLine lane={accountLane} />
      {all.length === 0 && <div className="row-end"><BrowserImportButton platform="douyu" disabled={accountsBusy} /></div>}
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
  const [removing, setRemoving] = useState(false)
  const shown = accountName(account)
  // Spoken in notices; an unnamed account is just 斗鱼账号.
  const who = shown || '斗鱼账号'

  const login = (): void => {
    void accountAction(`请在登录卡片中登录 ${who}，完成后将自动关闭`,
      () => apiClient.loginDouyuAccount(account.id),
      snapshot => {
        const login = snapshot.accounts.find(item => item.id === account.id)?.login
        return login?.loggedIn ? `${who} 已登录` : displayError({ code: 'login-incomplete', accountId: account.id, login }, `${who} 登录未完成，请重试`)
      })
  }

  return (
    <li className="account" data-active={active} role="group" aria-label={`斗鱼账号 ${account.label}`}>
      <div className="account-main">
        {account.login.avatar && <AccountAvatar username={shown || account.label} avatar={account.login.avatar} />}
        {shown && <span className="account-name">{shown}</span>}
        {active && <span className="tag">当前使用</span>}
        <span className="muted">{accountState(account)}</span>
      </div>

      {removing ? (
        <div className="account-actions">
          <span className="note-warn">删除该账号及其任务？</span>
          <button type="button" className="btn-quiet small is-danger" disabled={locked}
            onClick={() => void accountAction('正在删除', () => apiClient.removeDouyuAccount(account.id), `已删除 ${who}`)}>删除</button>
          <button type="button" className="btn-quiet small" onClick={() => setRemoving(false)}>取消</button>
        </div>
      ) : (
        <div className="account-actions">
          <BrowserImportButton platform="douyu" accountId={account.id} disabled={locked} />
          {!active && (
            <button type="button" className="btn-quiet small" disabled={locked}
              onClick={() => void accountAction('正在切换', () => apiClient.activateDouyuAccount(account.id), `已切换到 ${who}`)}>
              设为当前
            </button>
          )}
          <button type="button" className={account.login.loggedIn ? 'btn-quiet small' : 'btn-solid small'} disabled={locked} onClick={login}>
            {account.login.loggedIn ? '重新登录' : '登录'}
          </button>
          <button type="button" className="btn-quiet small" disabled={locked}
            onClick={() => void accountAction(`请在卡片中打开 ${who} 的鱼吧，完成后关闭页面`,
              () => apiClient.loginDouyuYubaAccount(account.id), '鱼吧页面已关闭')}>
            登录鱼吧
          </button>
          <button type="button" className="btn-quiet small" disabled={locked || (!account.login.loggedIn && account.login.cookieCount === 0)}
            onClick={() => void accountAction('正在退出', () => apiClient.logoutDouyuAccount(account.id), `${who} 已退出`)}>
            退出
          </button>
          <button type="button" className="btn-quiet small is-danger" disabled={locked} onClick={() => setRemoving(true)}>删除</button>
        </div>
      )}
    </li>
  )
}
