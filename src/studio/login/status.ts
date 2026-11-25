import { apiClient } from '../../app/apiClient'
import type { LoginStatus } from '../../../electron/login'
import { remember, remembered } from '../../app/remembered'
import { errorDetails, type ErrorDetails } from '../../core/errorDetails'

let startedRevision = 0
let appliedRevision = 0

/** Keep successful reads even if the settings page that started them has closed. */
export async function refreshLoginStatus(onError?: (message: string, detail?: ErrorDetails) => void): Promise<LoginStatus | null> {
  const revision = ++startedRevision
  try {
    const result = await apiClient.loginStatus()
    const latest = remembered<LoginStatus>('login-status')
    if (revision < appliedRevision && latest) return latest
    if (!result.ok) { onError?.(result.message, errorDetails(result)); return null }
    if (!result.value?.youtube || !result.value?.douyu) return null
    appliedRevision = revision
    remember('login-status', result.value)
    return result.value
  } catch (error) {
    const latest = remembered<LoginStatus>('login-status')
    if (revision < appliedRevision && latest) return latest
    onError?.('账号状态暂时无法读取，请重试', errorDetails(error))
    return null
  }
}
