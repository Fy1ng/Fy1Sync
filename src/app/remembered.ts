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
const listeners = new Map<string, Set<() => void>>()

function notify(key: string): void {
  const bucket = listeners.get(key)
  if (!bucket) return
  for (const listener of [...bucket]) listener()
}

export function remembered<T>(key: string): T | undefined {
  return values.get(key) as T | undefined
}

export function remember<T>(key: string, value: T): void {
  const changed = !values.has(key) || !Object.is(values.get(key), value)
  values.set(key, value)
  if (changed) notify(key)
}

/** Drop what was kept under keys starting with `prefix`, e.g. after an account changes. */
export function forget(prefix: string): void {
  const removed: string[] = []
  for (const key of [...values.keys()]) {
    if (key.startsWith(prefix)) {
      values.delete(key)
      removed.push(key)
    }
  }
  for (const key of removed) notify(key)
}

/**
 * State that starts from the last value kept under `key` and writes every change back.
 * When `key` changes (another account), the value is that key's own on the same render, so
 * one account's data is never shown under another. `key` null keeps nothing.
 */
export function useRemembered<T>(key: string | null, initial: T): [T, (value: T | ((previous: T) => T)) => void] {
  const initialRef = useRef(initial)
  initialRef.current = initial
  const read = useCallback((target: string | null): T =>
    target === null ? initialRef.current : (values.has(target) ? (values.get(target) as T) : initialRef.current), [])
  const [state, setState] = useState<{ key: string | null; value: T }>(() => ({ key, value: read(key) }))
  const current = state.key === key ? state.value : read(key)
  const keyRef = useRef(key)
  keyRef.current = key
  const currentRef = useRef(current)
  currentRef.current = current

  useEffect(() => {
    setState((previous) => {
      const next = read(key)
      return previous.key === key && Object.is(previous.value, next) ? previous : { key, value: next }
    })
    if (key === null) return
    let bucket = listeners.get(key)
    if (!bucket) {
      bucket = new Set()
      listeners.set(key, bucket)
    }
    const onChange = (): void => {
      setState((previous) => {
        const next = read(key)
        return previous.key === key && Object.is(previous.value, next) ? previous : { key, value: next }
      })
    }
    bucket.add(onChange)
    return () => {
      bucket.delete(onChange)
      if (bucket.size === 0 && listeners.get(key) === bucket) listeners.delete(key)
    }
  }, [key, read])

  const update = useCallback((value: T | ((previous: T) => T)) => {
    const at = keyRef.current
    const base = at === null ? currentRef.current : (values.has(at) ? (values.get(at) as T) : initialRef.current)
    const next = typeof value === 'function' ? (value as (previous: T) => T)(base) : value
    currentRef.current = next
    if (at !== null) remember(at, next)
    setState((previous) => previous.key === at && Object.is(previous.value, next) ? previous : { key: at, value: next })
  }, [])
  return [current, update]
}

/** Test seam: start every test from nothing. */
export function forgetAll(): void {
  const keys = [...values.keys()]
  values.clear()
  for (const key of keys) notify(key)
}
