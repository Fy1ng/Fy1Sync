import { useEffect } from 'react'
import { apiClient } from '../../app/apiClient'
import type { LoginPlatform, LoginStatus } from '../../../electron/login'
import { remember, remembered, useRemembered } from '../../app/remembered'
import { errorDetails, type ErrorDetails } from '../../core/errorDetails'
import { subscribeLoginStateChanged } from '../../core/loginEvents'

let startedRevision = 0
let appliedRevision = 0
const LOGIN_PLATFORM_KEYS: ReadonlySet<string> = new Set<LoginPlatform>(['youtube', 'twitch', 'douyu', 'bilibili', 'huya', 'douyin'])

export function isLoginPlatformKey(platform: string | undefined): platform is LoginPlatform {
  return platform !== undefined && LOGIN_PLATFORM_KEYS.has(platform)
}

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

/** Shared login state for controls that unlock options as soon as an account signs in. */
export function useLoginStatus(enabled = true): LoginStatus | null {
  const [status] = useRemembered<LoginStatus | null>('login-status', null)
  useEffect(() => {
    if (!enabled) return
    if (!remembered<LoginStatus>('login-status')) void refreshLoginStatus()
    let activeEmbedded = false
    const releaseLogin = subscribeLoginStateChanged(() => { void refreshLoginStatus() })
    const releaseEmbedded = apiClient.subscribeEmbeddedLogin((state) => {
      if (activeEmbedded && (!state || state.purpose !== 'login')) void refreshLoginStatus()
      activeEmbedded = Boolean(state && state.purpose === 'login')
    })
    const releaseDouyu = apiClient.subscribeDouyuAccounts(() => { void refreshLoginStatus() })
    return () => { releaseLogin(); releaseEmbedded(); releaseDouyu() }
  }, [enabled])
  return status
}
