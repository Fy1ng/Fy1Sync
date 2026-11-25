import { describe, expect, it, vi } from 'vitest'
import { ApplicationLifecycle, createStartupFailureReporter, formatStartupFailureDialog } from './applicationLifecycle'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const native = { isDestroyed: () => false, isMinimized: vi.fn(() => false), restore: vi.fn(), show: vi.fn(), focus: vi.fn() }
  let window: typeof native | null = null
  const start = vi.fn(async () => { window = native })
  const dispose = vi.fn(async () => {})
  const lifecycle = new ApplicationLifecycle({ window: () => window, start, dispose })
  return { native, start, dispose, lifecycle, close: () => { window = null; return lifecycle.closed() } }
}

describe('application window lifecycle', () => {
  it('runs a hidden test window without presenting it or changing desktop focus', async () => {
    const native = { isDestroyed: () => false, isMinimized: vi.fn(() => true), restore: vi.fn(), show: vi.fn(), focus: vi.fn() }
    let window: typeof native | null = null
    const start = vi.fn(async () => { window = native })
    const lifecycle = new ApplicationLifecycle({ window: () => window, start, dispose: async () => {}, present: false })
    await lifecycle.activate()
    await lifecycle.activate()
    expect(start).toHaveBeenCalledTimes(1)
    expect(native.restore).not.toHaveBeenCalled()
    expect(native.show).not.toHaveBeenCalled()
    expect(native.focus).not.toHaveBeenCalled()
  })

  it('opens once for simultaneous activation and restores an existing minimized window', async () => {
    const f = fixture()
    await Promise.all([f.lifecycle.activate(), f.lifecycle.activate()])
    expect(f.start).toHaveBeenCalledTimes(1)
    f.native.isMinimized.mockReturnValue(true)
    await f.lifecycle.activate()
    expect(f.native.restore).toHaveBeenCalledTimes(1)
    expect(f.native.focus).toHaveBeenCalled()
    expect(f.start).toHaveBeenCalledTimes(1)
  })

  it('waits for old IPC and protocol resources before reopening after close', async () => {
    const f = fixture(), cleaning = deferred()
    f.dispose.mockReturnValueOnce(cleaning.promise)
    await f.lifecycle.activate()
    const closed = f.close()
    const reopened = f.lifecycle.activate()
    await Promise.resolve()
    expect(f.start).toHaveBeenCalledTimes(1)
    cleaning.resolve()
    await Promise.all([closed, reopened])
    expect(f.dispose).toHaveBeenCalledTimes(1)
    expect(f.start).toHaveBeenCalledTimes(2)
  })

  it('cancels a queued Dock reopen when quitting during cleanup', async () => {
    const f = fixture(), cleaning = deferred()
    f.dispose.mockReturnValueOnce(cleaning.promise)
    await f.lifecycle.activate()
    const closed = f.close(), reopened = f.lifecycle.activate(), quit = f.lifecycle.quit()
    cleaning.resolve()
    await Promise.all([closed, reopened, quit])
    await f.lifecycle.activate()
    expect(f.start).toHaveBeenCalledTimes(1)
  })

  it('finishes an in-flight startup before final cleanup and shares repeated quit requests', async () => {
    const f = fixture(), starting = deferred(), entered = deferred()
    f.start.mockImplementationOnce(async () => { entered.resolve(); await starting.promise })
    const opened = f.lifecycle.activate()
    await entered.promise
    const first = f.lifecycle.quit(), second = f.lifecycle.quit()
    expect(first).toBe(second)
    expect(f.dispose).not.toHaveBeenCalled()
    starting.resolve()
    await Promise.all([opened, first, second])
    expect(f.dispose).toHaveBeenCalledTimes(1)
    expect(f.native.show).not.toHaveBeenCalled()
  })

  it('keeps a failed cleanup from racing a new startup', async () => {
    const f = fixture(), cleaning = deferred()
    await f.lifecycle.activate()
    f.dispose.mockImplementationOnce(async () => { await cleaning.promise; throw new Error('cleanup failed') })
    const closed = f.close(), reopened = f.lifecycle.activate()
    const rejected = Promise.all([expect(closed).rejects.toThrow('cleanup failed'), expect(reopened).rejects.toThrow('cleanup failed')])
    cleaning.resolve()
    await rejected
    expect(f.start).toHaveBeenCalledTimes(1)
  })

  it('shows a sanitized native startup error dialog outside E2E and exits once', () => {
    const log = vi.fn()
    const showErrorBox = vi.fn()
    const exit = vi.fn()
    const report = createStartupFailureReporter({ log, showErrorBox, exit })

    report(Object.assign(
      new Error('EACCES: permission denied, mkdir C:\\Users\\Alice\\AppData\\Roaming\\Fy1Sync Cookie: SESSDATA=secret123'),
      { code: 'EACCES' },
    ))
    report(new Error('second failure ignored'))

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('应用启动失败, 请检查构建产物和数据目录')
    expect(showErrorBox).toHaveBeenCalledTimes(1)
    const [title, content] = showErrorBox.mock.calls[0]!
    expect(title).toBe('Fy1Sync 启动失败')
    expect(content).toContain('应用无法完成初始化')
    expect(content).toContain('[user]\\AppData\\Roaming\\Fy1Sync')
    expect(content).not.toContain('Alice')
    expect(content).not.toContain('secret123')
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('suppresses blocking modal dialogs in E2E mode and tolerates dialog or stderr failures', () => {
    const e2eShow = vi.fn()
    const e2eExit = vi.fn()
    createStartupFailureReporter({ e2e: true, log: () => {}, showErrorBox: e2eShow, exit: e2eExit })(new Error('账号数据路径无效'))
    expect(e2eShow).not.toHaveBeenCalled()
    expect(e2eExit).toHaveBeenCalledWith(1)

    const fallbackExit = vi.fn()
    createStartupFailureReporter({
      log: () => { throw new Error('broken pipe') },
      showErrorBox: () => { throw new Error('headless') },
      exit: fallbackExit,
    })(null)
    expect(fallbackExit).toHaveBeenCalledWith(1)
    expect(formatStartupFailureDialog(undefined).content).not.toContain('原因：')
  })
})
