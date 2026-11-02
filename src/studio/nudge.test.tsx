import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { SyncCapsule } from './sync'

let session: Session

beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async () => ({ ok: true, value: { presets: [] } })) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  session?.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mount(steps = { smallStepSeconds: 0.5, largeStepSeconds: 5 }) {
  session = new Session({ createSampler: () => null })
  session.updateSettings(steps)
  for (const role of ['official', 'commentary'] as const) {
    await session.loadSource(role, { kind: 'test', url: '/test.mp4', input: role, label: role, loop: true, viaProxy: false, platform: 'test' })
  }
  const apply = vi.spyOn(session, 'applyOffset').mockResolvedValue({} as Awaited<ReturnType<Session['applyOffset']>>)
  const view = render(<SessionProvider session={session}><div className="studio"><SyncCapsule /></div></SessionProvider>)
  return { ...view, apply, back: screen.getByRole('button', { name: '回退画面' }), forward: screen.getByRole('button', { name: '快进画面' }) }
}

describe('manual alignment nudge controls', () => {
  it('keeps the normal labels, shows the fine-adjustment hint and uses a large step for a click', async () => {
    const { back, forward, apply } = await mount()
    expect(back).toHaveClass('capsule-nudge')
    expect(back.querySelector('.capsule-nudge-label')).toHaveTextContent('回退画面')
    expect(forward.querySelector('.capsule-nudge-label')).toHaveTextContent('快进画面')
    for (const button of [back, forward]) {
      expect(button.querySelector('.capsule-nudge-step .icon path')?.getAttribute('d'))
        .toBe(button.querySelector('.capsule-nudge-label .icon path')?.getAttribute('d'))
    }
    expect(back.querySelector('.capsule-nudge-hint')).toHaveTextContent('按住Shift微调')
    expect(forward.querySelector('.capsule-nudge-hint')).toHaveTextContent('按住Shift微调')
    fireEvent.click(back)
    expect(apply).toHaveBeenLastCalledWith(5)
    fireEvent.click(forward, { shiftKey: true })
    expect(apply).toHaveBeenLastCalledWith(4.5)
    fireEvent.click(forward)
    expect(apply).toHaveBeenLastCalledWith(-0.5)
  })

  it('updates both displayed step values immediately when Shift changes while hovered', async () => {
    const { back, forward } = await mount()
    fireEvent.pointerEnter(forward)
    expect(back.querySelector('.capsule-nudge-step')).toHaveTextContent('5s')
    expect(forward.querySelector('.capsule-nudge-step')).toHaveTextContent('5s')
    fireEvent.keyDown(window, { key: 'Shift', code: 'ShiftLeft', shiftKey: true })
    expect(back.querySelector('.capsule-nudge-step')).toHaveTextContent('0.5s')
    expect(forward.querySelector('.capsule-nudge-step')).toHaveTextContent('0.5s')
    expect(forward.title).toContain('0.5s')
    fireEvent.keyUp(window, { key: 'Shift', code: 'ShiftLeft', shiftKey: false })
    expect(forward.querySelector('.capsule-nudge-step')).toHaveTextContent('5s')
    fireEvent.pointerEnter(back, { shiftKey: true })
    expect(back.querySelector('.capsule-nudge-step')).toHaveTextContent('0.5s')
    fireEvent.blur(window)
    expect(back.querySelector('.capsule-nudge-step')).toHaveTextContent('5s')
  })

  it('changes repeat steps immediately on Shift down and up, even after a long hold', async () => {
    const { back, apply } = await mount({ smallStepSeconds: 0.25, largeStepSeconds: 1 })
    vi.useFakeTimers()
    fireEvent.pointerDown(back, { button: 0, pointerId: 1 })
    expect(apply).toHaveBeenLastCalledWith(1)
    act(() => vi.advanceTimersByTime(1800))
    const largeSteps = apply.mock.calls.map(call => Number(call[0]))
    expect(largeSteps.length).toBeGreaterThan(8)
    expect(largeSteps.every((value, index) => value - (largeSteps[index - 1] ?? 0) === 1)).toBe(true)
    fireEvent.keyDown(window, { key: 'Shift', code: 'ShiftLeft', shiftKey: true })
    const fineIndex = apply.mock.calls.length
    act(() => vi.advanceTimersByTime(200))
    const fineCalls = apply.mock.calls.slice(fineIndex - 1).map(call => Number(call[0]))
    expect(fineCalls.length).toBeGreaterThan(1)
    expect(fineCalls.slice(1).every((value, index) => value - fineCalls[index]! === 0.25)).toBe(true)
    fireEvent.keyUp(window, { key: 'Shift', code: 'ShiftLeft', shiftKey: false })
    const largeIndex = apply.mock.calls.length
    act(() => vi.advanceTimersByTime(200))
    const largeCalls = apply.mock.calls.slice(largeIndex - 1).map(call => Number(call[0]))
    expect(largeCalls.length).toBeGreaterThan(1)
    expect(largeCalls.slice(1).every((value, index) => value - largeCalls[index]! === 1)).toBe(true)
    fireEvent.pointerUp(back, { button: 0, pointerId: 1 })
    const stopped = apply.mock.calls.length
    act(() => vi.advanceTimersByTime(1000))
    expect(apply).toHaveBeenCalledTimes(stopped)
  })

  it('honors Shift on the initial pointer press and stops repetition when the window loses focus', async () => {
    const { forward, apply } = await mount()
    vi.useFakeTimers()
    fireEvent.pointerDown(forward, { button: 0, pointerId: 1, shiftKey: true })
    expect(apply).toHaveBeenLastCalledWith(-0.5)
    fireEvent.blur(window)
    const stopped = apply.mock.calls.length
    act(() => vi.advanceTimersByTime(1000))
    expect(apply).toHaveBeenCalledTimes(stopped)
    fireEvent.click(forward)
    expect(apply).toHaveBeenLastCalledWith(-5.5)
  })
})
