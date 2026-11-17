import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { installExternalNavigation } from './externalNavigation'

function fixture(document = 'app://app/') {
  const events = new EventEmitter()
  let popup: (details: { url: string }) => { action: string }
  const contents = Object.assign(events, { getURL: () => document, setWindowOpenHandler: (handler: typeof popup) => { popup = handler } }) as unknown as WebContents
  const open = vi.fn(async (_url: string) => {})
  const failure = vi.fn()
  installExternalNavigation(contents, open, undefined, failure)
  return { events, open, failure, popup: (url: string) => popup!({ url }) }
}

describe('external web navigation without app privileges', () => {
  it('opens ordinary links, redirects and new windows in the browser while preserving the app document', async () => {
    const f = fixture()
    for (const event of ['will-navigate', 'will-redirect']) {
      const preventDefault = vi.fn()
      f.events.emit(event, { preventDefault }, 'https://arbitrary.invalid:8443/path')
      expect(preventDefault).toHaveBeenCalledOnce()
    }
    expect(f.popup('http://127.0.0.1:9210/')).toEqual({ action: 'deny' })
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledTimes(3))
    expect(f.open).toHaveBeenCalledWith('https://arbitrary.invalid:8443/path')
    expect(f.open).toHaveBeenCalledWith('http://127.0.0.1:9210/')
  })

  it('keeps internal navigation and does not launch executable schemes or grant a remote document browser access', async () => {
    const f = fixture(), preventDefault = vi.fn()
    f.events.emit('will-navigate', { preventDefault }, 'app://app/admin')
    expect(preventDefault).not.toHaveBeenCalled()
    for (const url of ['file:///private', 'javascript:alert(1)', 'powershell:command', 'invalid']) f.popup(url)
    const remote = fixture('https://remote.invalid/')
    remote.popup('https://other.invalid/')
    await Promise.resolve(); await Promise.resolve()
    expect(f.open).not.toHaveBeenCalled()
    expect(remote.open).not.toHaveBeenCalled()
  })

  it('reports an actual browser launch failure without exposing the target or credentials', async () => {
    const f = fixture()
    f.open.mockRejectedValueOnce(new Error('synthetic failure'))
    f.popup('https://example.invalid/')
    await vi.waitFor(() => expect(f.failure).toHaveBeenCalledOnce())
    expect(f.failure).toHaveBeenCalledWith()
  })
})
