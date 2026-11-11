import { describe, expect, it, vi } from 'vitest'
import { DouyuGatewayCoordinator } from './gatewayCoordinator'

describe('account gateway ownership', () => {
  it('waits for the watch transport to terminate before a short operation starts', async () => {
    const coordinator = new DouyuGatewayCoordinator()
    let release!: () => void
    let watchSignal!: AbortSignal
    const watch = coordinator.runWatch('default', new AbortController().signal, signal => {
      watchSignal = signal
      return new Promise<void>(resolve => { release = resolve })
    })
    await Promise.resolve()
    const run = vi.fn(async () => 'sent')
    const short = coordinator.runShort('default', new AbortController().signal, run)
    expect(watchSignal.aborted).toBe(true)
    expect(coordinator.isBusy('default')).toBe(true)
    expect(run).not.toHaveBeenCalled()
    release()
    await watch
    expect(await short).toBe('sent')
    expect(coordinator.isBusy('default')).toBe(false)
    coordinator.dispose()
  })

  it('does not reacquire viewing while a short operation owns the account', async () => {
    const coordinator = new DouyuGatewayCoordinator()
    let release!: () => void
    const short = coordinator.runShort('default', new AbortController().signal, () => new Promise<void>(resolve => { release = resolve }))
    const run = vi.fn(async () => {})
    await expect(coordinator.runWatch('default', new AbortController().signal, run)).rejects.toMatchObject({ name: 'AbortError' })
    expect(run).not.toHaveBeenCalled()
    release(); await short
    coordinator.dispose()
  })

  it('keeps accounts independent and releases a cancelled short waiter', async () => {
    const coordinator = new DouyuGatewayCoordinator()
    let release!: () => void
    const watch = coordinator.runWatch('first', new AbortController().signal, () => new Promise<void>(resolve => { release = resolve }))
    await Promise.resolve()
    const controller = new AbortController()
    const run = vi.fn(async () => {})
    const short = coordinator.runShort('first', controller.signal, run)
    const rejection = expect(short).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await rejection
    expect(run).not.toHaveBeenCalled()
    expect(await coordinator.runShort('second', new AbortController().signal, async () => 42)).toBe(42)
    release(); await watch
    expect(coordinator.isBusy('first')).toBe(false)
    coordinator.dispose()
  })
})
