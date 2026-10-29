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
/** Main said something changed while a read was already in flight; that read may predate it. */
let stale = false
/** Requests run in order; a reply older than the one already kept is not kept. */
let issued = 0
let kept = 0
const readers = new Set<(schedule: Cs2Schedule) => void>()

/** Read the schedule; a plain read joins one already in flight. */
export function readSchedule(refresh = false): Promise<ApiResult<Cs2Schedule>> {
  if (!refresh && pending) return pending
  const order = ++issued
  const run = apiClient.feature('getCs2Schedule', refresh ? { refresh: true } : undefined).then((result) => {
    if (result.ok && order > kept) {
      kept = order
      latest = result.value
      for (const reader of readers) reader(result.value)
    }
    return result
  }).finally(() => {
    if (pending !== run) return
    pending = null
    // Read once more for the change that arrived meanwhile, so its crest is not left for the poll.
    if (stale) { stale = false; void readSchedule().catch(() => undefined) }
  })
  pending = run
  return run
}

/** Main says tiers or crests changed: read now, or once the read in flight is done. */
export function scheduleChanged(): void {
  if (pending) stale = true
  else void readSchedule().catch(() => undefined)
}

/** Every schedule this window keeps, including reads it started on its own. */
export function onSchedule(reader: (schedule: Cs2Schedule) => void): () => void {
  readers.add(reader)
  return () => { readers.delete(reader) }
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
  apiClient.subscribeFeatures((event) => { if (event.topic === 'cs2-schedule') scheduleChanged() })
}

export function lastSchedule(): Cs2Schedule | null {
  return latest
}
