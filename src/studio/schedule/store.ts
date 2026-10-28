/**
 * The last schedule this window has read, kept outside the sheet so the sheet opens on data.
 *
 * The studio reads once at start-up; the sheet paints from what is here and asks again. Main
 * caches and rate-limits Liquipedia, so the early read costs no extra request.
 */

import { apiClient, type ApiResult } from '../../app/apiClient'
import type { Cs2Schedule } from '../../../electron/featureContracts'

let latest: Cs2Schedule | null = null
let pending: Promise<ApiResult<Cs2Schedule>> | null = null

/** Read the schedule; a plain read joins one already in flight. */
export function readSchedule(refresh = false): Promise<ApiResult<Cs2Schedule>> {
  if (!refresh && pending) return pending
  const run = apiClient.feature('getCs2Schedule', refresh ? { refresh: true } : undefined).then((result) => {
    if (result.ok) latest = result.value
    return result
  }).finally(() => { if (pending === run) pending = null })
  pending = run
  return run
}

let listening = false

/**
 * Read now, and again whenever main says tiers or crests landed, so the copy kept here is the
 * one the sheet opens on even if it was closed when they arrived.
 */
export function prefetchSchedule(): void {
  void readSchedule().catch(() => undefined)
  if (listening) return
  listening = true
  apiClient.subscribeFeatures((event) => {
    if (event.topic === 'cs2-schedule') void readSchedule().catch(() => undefined)
  })
}

export function lastSchedule(): Cs2Schedule | null {
  return latest
}
