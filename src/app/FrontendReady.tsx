import { useEffect } from 'react'
import { apiClient } from './apiClient'
import frontendBuild from '../../packaging/frontend-build.json'

/** A mounted React tree and a working IPC bridge must survive before acknowledging a trial. */
export function FrontendReady(): null {
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    void apiClient.health().then(result => {
      if (cancelled || !result.ok || !result.value.ok) return
      timer = setTimeout(() => {
        if (!cancelled) void apiClient.feature('reportFrontendReady', { bridgeVersion: frontendBuild.bridgeVersion })
      }, 2_000)
    })
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [])
  return null
}
