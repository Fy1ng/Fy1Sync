/**
 * 斗鱼写操作 is off until the viewer confirms the risk, and turning it off needs no confirmation.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { DEFAULT_SETTINGS, mergeSettings } from '../app/settings'
import { DouyuWritesPane } from './douyuWrites'

const sessions: Session[] = []
afterEach(() => {
  cleanup()
  for (const session of sessions.splice(0)) session.dispose()
  localStorage.clear()
})

function renderPane(): Session {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  render(<SessionProvider session={session}><DouyuWritesPane /></SessionProvider>)
  return session
}

describe('斗鱼写操作', () => {
  it('is off by default and only a boolean turns it on', () => {
    expect(DEFAULT_SETTINGS.douyuWrites).toBe(false)
    expect(mergeSettings({}).douyuWrites).toBe(false)
    expect(mergeSettings({ douyuWrites: 'yes' } as unknown).douyuWrites).toBe(false)
    expect(mergeSettings({ douyuWrites: true }).douyuWrites).toBe(true)
  })

  it('asks before turning on, and cancel leaves it off', () => {
    const session = renderPane()
    const toggle = screen.getByRole('switch', { name: /^斗鱼写操作/ })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    expect(session.settings.douyuWrites).toBe(false)
    expect(screen.getByRole('group', { name: '确认打开斗鱼写操作' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(session.settings.douyuWrites).toBe(false)
    expect(screen.getByRole('switch', { name: /^斗鱼写操作/ })).not.toBeChecked()
  })

  it('turns on after confirming and off again in one click', async () => {
    const session = renderPane()
    fireEvent.click(screen.getByRole('switch', { name: /^斗鱼写操作/ }))
    fireEvent.click(screen.getByRole('button', { name: '确认打开' }))
    expect(session.settings.douyuWrites).toBe(true)
    await waitFor(() => expect(screen.getByRole('switch', { name: /^斗鱼写操作/ })).toBeChecked())
    fireEvent.click(screen.getByRole('switch', { name: /^斗鱼写操作/ }))
    expect(session.settings.douyuWrites).toBe(false)
  })
})
