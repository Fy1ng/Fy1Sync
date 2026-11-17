import { apiClient } from '../../app/apiClient'
import type { LoginStatus } from '../../../electron/login'
import { remember } from '../../app/remembered'
import { errorDetails, type ErrorDetails } from '../../core/errorDetails'

let readRevision = 0

/** Keep successful reads even if the settings page that started them has closed. */
export async function refreshLoginStatus(onError?: (message: string, detail?: ErrorDetails) => void): Promise<LoginStatus | null> {
  const revision = ++readRevision
  try {
    const result = await apiClient.loginStatus()
    if (revision !== readRevision) return null
    if (!result.ok) { onError?.(result.message, errorDetails(result)); return null }
    if (!result.value?.youtube || !result.value?.douyu) return null
    remember('login-status', result.value)
    return result.value
  } catch (error) {
    if (revision === readRevision) onError?.('账号状态暂时无法读取, 请重试.', errorDetails(error))
    return null
  }
}
