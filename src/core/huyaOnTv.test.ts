import { expect, it } from 'vitest'
import { HuyaOnTvReminders } from './huyaOnTv'
import type { HuyaOnTvSnapshot } from '../../server/platforms/huyaOnTv'
const snapshot: HuyaOnTvSnapshot = { room: 'huya:99798', status: 'active', observedAt: 1800000000000,
  activity: { id: '4096', title: '', prize: '', mode: 2, conditions: [], cost: '', qualification: 'unknown', endsAt: 1800000060000, serverNow: 1800000000000 } }
it('remembers a live activity across session restart, while remaining disabled until opted in', () => {
  const saved = new Map<string, string>(), storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value) } }
  const first = new HuyaOnTvReminders(storage)
  expect(first.shouldRemind(snapshot, false, snapshot.observedAt)).toBe(false)
  expect(first.shouldRemind(snapshot, true, snapshot.observedAt)).toBe(true)
  expect(new HuyaOnTvReminders(storage).shouldRemind(snapshot, true, snapshot.observedAt + 1000)).toBe(false)
  expect(new HuyaOnTvReminders(storage).shouldRemind({ ...snapshot, status: 'ended' }, true, snapshot.observedAt + 2000)).toBe(false)
})
it('tolerates corrupt storage and ignores expired activity snapshots', () => {
  const reminders = new HuyaOnTvReminders({ getItem: () => '{', setItem() { throw new Error('storage unavailable') } })
  expect(reminders.shouldRemind(snapshot, true, snapshot.observedAt + 61000)).toBe(false)
  expect(reminders.shouldRemind(snapshot, true, snapshot.observedAt)).toBe(true)
  expect(reminders.shouldRemind(snapshot, true, snapshot.observedAt)).toBe(false)
})
