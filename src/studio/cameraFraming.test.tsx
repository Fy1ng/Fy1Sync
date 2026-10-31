/**
 * The camera framing sheet must come up usable: its preview canvas mounts a commit after the
 * sheet itself (Sheet waits for the dialog to open), and it has to start reading frames then.
 */

import { StrictMode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { primeMediaElement } from '../test/setup'
import { CameraFraming } from './CameraFraming'

const sessions: Session[] = []
afterEach(() => {
  cleanup()
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.restoreAllMocks()
})

describe('摄像头小窗', () => {
  it('shows the commentary frame and enables 保存 once it is open', async () => {
    const session = new Session({ createSampler: () => null })
    sessions.push(session)
    const video = session.engine.element('commentary')
    Object.defineProperties(video, { videoWidth: { configurable: true, value: 1280 }, videoHeight: { configurable: true, value: 720 } })
    primeMediaElement(video, { duration: 60, currentTime: 3 })
    const drawn = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: drawn } as unknown as CanvasRenderingContext2D)

    render(<StrictMode><SessionProvider session={session}>
      <CameraFraming initial={null} onSave={() => {}} onRemove={null} onClose={() => {}} />
    </SessionProvider></StrictMode>)

    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled())
    expect(drawn).toHaveBeenCalled()
  })
})
