/**
 * Panels remember what they last read, so reopening one shows it at once and only brings it
 * up to date.
 *
 * Settings, the Douyu desk and 赛程 unmount when closed; their reads used to start from
 * nothing every time, which looked like the whole panel loading again. A value here lives for
 * the window (not across a restart) and is keyed by what was read, e.g. the account it is for.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const values = new Map<string, unknown>()

export function remembered<T>(key: string): T | undefined {
  return values.get(key) as T | undefined
}

export function remember<T>(key: string, value: T): void {
  values.set(key, value)
}

/** Drop what was kept under keys starting with `prefix`, e.g. after an account changes. */
export function forget(prefix: string): void {
  for (const key of [...values.keys()]) if (key.startsWith(prefix)) values.delete(key)
}

/**
 * State that starts from the last value kept under `key` and writes every change back.
 * When `key` changes (another account), the value is that key's own on the same render, so
 * one account's data is never shown under another. `key` null keeps nothing.
 */
export function useRemembered<T>(key: string | null, initial: T): [T, (value: T | ((previous: T) => T)) => void] {
  const fresh = (): T => key === null ? initial : remembered<T>(key) ?? initial
  const [state, setState] = useState<{ key: string | null; value: T }>(() => ({ key, value: fresh() }))
  const current = state.key === key ? state.value : fresh()
  const keyRef = useRef(key)
  keyRef.current = key
  useEffect(() => { if (state.key !== key) setState({ key, value: fresh() }) }, [key])
  const update = useCallback((value: T | ((previous: T) => T)) => {
    const at = keyRef.current
    setState((previous) => {
      const base = previous.key === at ? previous.value : (at === null ? initial : remembered<T>(at) ?? initial)
      const next = typeof value === 'function' ? (value as (previous: T) => T)(base) : value
      if (at !== null) values.set(at, next)
      return { key: at, value: next }
    })
  }, [])
  return [current, update]
}

/** Test seam: start every test from nothing. */
export function forgetAll(): void {
  values.clear()
}
