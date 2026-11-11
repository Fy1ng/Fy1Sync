import { apiClient } from '../../app/apiClient'
import type { LoginStatus } from '../../../electron/login'
import { remember } from '../../app/remembered'

let readRevision = 0

/** Keep successful reads even if the settings page that started them has closed. */
export async function refreshLoginStatus(onError?: (message: string) => void): Promise<LoginStatus | null> {
  const revision = ++readRevision
  try {
    const result = await apiClient.loginStatus()
    if (revision !== readRevision) return null
    if (!result.ok) { onError?.(result.message); return null }
    if (!result.value?.youtube || !result.value?.douyu) return null
    remember('login-status', result.value)
    return result.value
  } catch {
    if (revision === readRevision) onError?.('账号状态暂时无法读取, 请重试.')
    return null
  }
}
