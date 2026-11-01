/**
 * The camera framing sheet must come up usable: its preview canvas mounts a commit after the
 * sheet itself (Sheet waits for the dialog to open), and it has to start reading frames then.
 */

import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { primeMediaElement } from '../test/setup'
import { CameraFraming } from './CameraFraming'

const sample = vi.hoisted(() => vi.fn())
const tighten = vi.hoisted(() => vi.fn())
vi.mock('../ui/cameraFrames', async importOriginal => ({ ...await importOriginal<typeof import('../ui/cameraFrames')>(), sampleCameraFrames: sample }))
vi.mock('../ui/cameraTighten', () => ({ tightenCamera: tighten }))
beforeEach(() => { sample.mockReset().mockResolvedValue({ frames: new Uint8Array(), width: 80, height: 60 }); tighten.mockReset() })

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

  const rough = { x: 0.1, y: 0.2, w: 0.4, h: 0.4 }
  const fitted = { x: 0.12, y: 0.22, w: 0.35, h: 0.35 }
  async function open() {
    const session = new Session({ createSampler: () => null })
    sessions.push(session)
    const video = session.engine.element('commentary')
    Object.defineProperties(video, { videoWidth: { configurable: true, value: 1280 }, videoHeight: { configurable: true, value: 720 } })
    primeMediaElement(video, { duration: 60, currentTime: 3 })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
    const save = vi.fn()
    render(<SessionProvider session={session}><CameraFraming initial={rough} onSave={save} onRemove={null} onClose={() => {}} /></SessionProvider>)
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled())
    return { save, video }
  }

  it('keeps ambiguous results unchanged and lets the viewer undo an accepted fit before saving', async () => {
    const { save } = await open()
    tighten.mockResolvedValue({ roi: fitted, found: [true, true, true, true], ambiguous: true })
    fireEvent.click(screen.getByRole('button', { name: '贴边' }))
    expect(await screen.findByRole('status')).toHaveTextContent('多个相近边界')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save).toHaveBeenLastCalledWith(rough)
    tighten.mockResolvedValue({ roi: fitted, found: [true, true, true, true], ambiguous: false })
    fireEvent.click(screen.getByRole('button', { name: '贴边' }))
    const undo = await screen.findByRole('button', { name: '撤回贴边' })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save).toHaveBeenLastCalledWith(fitted)
    fireEvent.click(undo)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save).toHaveBeenLastCalledWith(rough)
  })

  it('does not apply a late worker result after a source seek cancels the analysis', async () => {
    const { save, video } = await open()
    let finish!: (value: unknown) => void
    tighten.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '贴边' }))
    await waitFor(() => expect(tighten).toHaveBeenCalledOnce())
    fireEvent(video, new Event('seeking'))
    await act(async () => { finish({ roi: fitted, found: [true, true, true, true], ambiguous: false }) })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save).toHaveBeenCalledWith(rough)
    expect(screen.getByRole('status')).toHaveTextContent('画面已变化')
    expect(screen.queryByRole('button', { name: '撤回贴边' })).toBeNull()
  })

  it('explains paused sampling instead of reporting an unexplained generic failure', async () => {
    const { save } = await open()
    sample.mockRejectedValue(new Error('解说已暂停. 请恢复播放后重新贴边.'))
    fireEvent.click(screen.getByRole('button', { name: '贴边' }))
    expect(await screen.findByRole('status')).toHaveTextContent('解说已暂停')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save).toHaveBeenCalledWith(rough)
    expect(tighten).not.toHaveBeenCalled()
  })
})
