/**
 * Which side the dock's 增强画中画 opens: the commentary whenever one is loaded, because that
 * window takes over the sound; a lone picture still opens itself.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import type { StreamSyncerBridge } from '../../electron/contracts'
import type { SourceRole } from '../core/types'
import { PipButton } from './PipButton'

const sessions: Session[] = []
let invoke: ReturnType<typeof vi.fn>

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  invoke = vi.fn(async (method: string) => {
    if (method === 'getEnhancedPip') return { ok: true, value: { phase: 'closed' } }
    if (method === 'openEnhancedPip') return { ok: true, value: { phase: 'opening' } }
    return { ok: true, value: {} }
  })
  vi.stubGlobal('streamSyncer', {
    invoke: invoke as unknown as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.unstubAllGlobals()
})

async function setup(roles: SourceRole[]): Promise<Session> {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  for (const role of roles) {
    void session.loadSource(role, { kind: 'test', url: `/test-sources/${role}.mp4`, input: role, label: role, loop: true, viaProxy: false, platform: 'test' })
  }
  render(<SessionProvider session={session}><PipButton /></SessionProvider>)
  await act(flush)
  fireEvent.click(screen.getByRole('button', { name: '画中画' }))
  return session
}

const enhanced = (): HTMLElement => screen.getByRole('button', { name: /增强画中画/ })

describe('the dock picture-in-picture', () => {
  it('opens the commentary in the enhanced window while the official picture is on the big screen', async () => {
    await setup(['official', 'commentary'])
    expect(enhanced()).toHaveTextContent('播放解说')
    fireEvent.click(enhanced())
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('openEnhancedPip', { id: 'commentary' }))
  })

  it('opens the commentary on the big screen without the extra note', async () => {
    const session = await setup(['official', 'commentary'])
    await act(async () => session.swapRoles())
    expect(enhanced()).not.toHaveTextContent('播放解说')
    fireEvent.click(enhanced())
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('openEnhancedPip', { id: 'commentary' }))
  })

  it('opens a lone official picture as before', async () => {
    await setup(['official'])
    expect(enhanced()).not.toHaveTextContent('播放解说')
    fireEvent.click(enhanced())
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('openEnhancedPip', { id: 'official' }))
  })
})
