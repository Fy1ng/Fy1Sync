import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionProvider } from '../app/SessionContext'
import type { Session, SessionSnapshot } from '../app/session'
import { mergeSettings, type DanmakuSettings } from '../app/settings'
import type { DanmakuMessage } from '../core/danmakuTimeline'
import { LOCAL_GIFT_EFFECT_DURATION_MS, MAX_LOCAL_GIFT_EFFECTS } from '../core/douyuLocalEffects'
import { DanmakuLayer } from './DanmakuLayer'
import { DanmakuSettingsPanel } from './DanmakuSettingsPanel'
import { createLocalGiftEffectNode, DouyuLocalIdentityBadge } from './DouyuLocalEffects'

const frame = vi.hoisted(() => ({ current: null as null | ((now: number) => void) }))
vi.mock('../app/hooks', async importOriginal => {
  const original = await importOriginal<typeof import('../app/hooks')>()
  return { ...original, useAnimationFrame: (callback: (now: number) => void) => { frame.current = callback } }
})

function store(initial: Partial<DanmakuSettings> = {}) {
  let snapshot = {
    settings: mergeSettings({ danmaku: initial }),
    danmaku: { room: '1234', connected: true, error: null, pending: 0, dropped: 0 },
  } as SessionSnapshot
  let pending: DanmakuMessage[] = []
  const listeners = new Set<() => void>()
  const publish = () => { for (const listener of listeners) listener() }
  const session = {
    get snapshot() { return snapshot },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    invalidPatterns: [],
    updateDanmakuSettings: vi.fn((patch: Partial<DanmakuSettings>) => {
      snapshot = { ...snapshot, settings: mergeSettings({ ...snapshot.settings, danmaku: { ...snapshot.settings.danmaku, ...patch } }) }
      publish()
    }),
    drainDanmaku: () => { const released = pending; pending = []; return released },
  }
  return {
    session: session as unknown as Session,
    enqueue: (...messages: DanmakuMessage[]) => { pending.push(...messages) },
    setRoom: (room: string | null) => { snapshot = { ...snapshot, danmaku: { ...snapshot.danmaku, room } }; publish() },
  }
}

const chat = (id: string, uid = '42'): DanmakuMessage => ({
  id, text: '  原文 <img> +1  ', user: '真实昵称', color: '#ffffff', scheduleTime: 100, receivedAt: 1_000,
  sender: { uid, level: 28, nobleLevel: 3 },
})
const gift = (id: string, count = 2): DanmakuMessage => ({
  ...chat(id), text: `粉丝荧光棒 x ${count}`, gift: { kind: 'prop', id: '268', count },
})

function renderLayer(state: ReturnType<typeof store>) {
  return render(<SessionProvider session={state.session}><DanmakuLayer /></SessionProvider>)
}
function tick(now = 1_000) { act(() => { frame.current!(now) }) }

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(560)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); frame.current = null })

describe('local identity badge', () => {
  it('is absent by default and labels only the configured sender without changing real facts', () => {
    const message = Object.freeze(chat('original'))
    Object.freeze(message.sender)
    const settings = { localPhantomIdentity: false, localPhantomUid: '42' }
    const view = render(<DouyuLocalIdentityBadge message={message} settings={settings} />)
    expect(view.container).toBeEmptyDOMElement()
    view.rerender(<DouyuLocalIdentityBadge message={message} settings={{ ...settings, localPhantomIdentity: true }} />)
    expect(screen.getByText('本地幻神')).toHaveAttribute('title', expect.stringContaining('不改变真实身份'))
    expect(message.sender).toEqual({ uid: '42', level: 28, nobleLevel: 3 })
    expect(message.text).toBe('  原文 <img> +1  ')
    view.rerender(<DouyuLocalIdentityBadge message={message} settings={{ localPhantomIdentity: true, localPhantomUid: '43' }} />)
    expect(view.container).toBeEmptyDOMElement()
  })
})

describe('local visuals in the frame-driven overlay', () => {
  it('leaves ordinary chat alone by default and never turns a gift notice into scrolling chat', () => {
    const state = store()
    const view = renderLayer(state)
    state.enqueue(chat('chat'), gift('gift'))
    tick()
    expect(view.container.querySelectorAll('.danmaku-item')).toHaveLength(1)
    expect(view.container.querySelector('.danmaku-item')?.textContent).toBe(chat('chat').text)
    expect(view.container.querySelector('.douyu-local-identity')).toBeNull()
    expect(view.container.querySelector('.douyu-local-gift')).toBeNull()
    expect(view.container.querySelector('img')).toBeNull()
  })

  it('switches the two effects off independently and immediately restores original text', () => {
    const state = store({ localPhantomIdentity: true, localPhantomUid: '42', localGlowstickToRocket: true })
    const view = renderLayer(state)
    const original = Object.freeze(chat('matching'))
    state.enqueue(original, chat('other', '43'), gift('gift'))
    tick()
    expect(view.container.querySelectorAll('.douyu-local-identity')).toHaveLength(1)
    expect(view.container.querySelector('.douyu-local-gift-source')).toHaveTextContent('粉丝荧光棒 x 2 / 真实昵称')
    expect(view.container.querySelector('.douyu-local-gift-title')).toHaveTextContent('本地超火特效')
    act(() => state.session.updateDanmakuSettings({ localPhantomIdentity: false }))
    expect(view.container.querySelector('.douyu-local-identity')).toBeNull()
    expect(view.container.querySelector('.danmaku-item')?.textContent).toBe(original.text)
    expect(view.container.querySelector('.douyu-local-gift')).not.toBeNull()
    act(() => state.session.updateDanmakuSettings({ localGlowstickToRocket: false }))
    expect(view.container.querySelector('.douyu-local-gift')).toBeNull()
    expect(view.container.querySelectorAll('.danmaku-item')).toHaveLength(2)
    expect(original.sender?.nobleLevel).toBe(3)
  })

  it('does not replay disabled gift events and removes old effects on a room change', () => {
    const state = store()
    const view = renderLayer(state)
    state.enqueue(gift('while-off'))
    tick()
    act(() => state.session.updateDanmakuSettings({ localGlowstickToRocket: true }))
    tick(2_000)
    expect(view.container.querySelector('.douyu-local-gift')).toBeNull()
    state.enqueue(gift('new-gift'))
    tick(2_100)
    expect(view.container.querySelector('.douyu-local-gift')).not.toBeNull()
    act(() => state.setRoom('9999'))
    expect(view.container.querySelector('.douyu-local-gift')).toBeNull()
  })

  it('clears effects when the overlay is disabled and continues draining the session', () => {
    const state = store({ localGlowstickToRocket: true })
    const view = renderLayer(state)
    state.enqueue(gift('gift'))
    tick()
    act(() => state.session.updateDanmakuSettings({ enabled: false }))
    expect(view.container.querySelector('.douyu-local-gift')).toBeNull()
    state.enqueue(gift('hidden'))
    tick(2_000)
    act(() => state.session.updateDanmakuSettings({ enabled: true }))
    tick(2_100)
    expect(view.container.querySelector('.douyu-local-gift')).toBeNull()
  })

  it('bounds a burst to three cards, retains the real count and expires without a backlog', () => {
    const state = store({ localGlowstickToRocket: true })
    const view = renderLayer(state)
    state.enqueue(...Array.from({ length: 200 }, (_, index) => gift(`g${index}`, 1_000_000)))
    tick()
    expect(view.container.querySelectorAll('.douyu-local-gift')).toHaveLength(MAX_LOCAL_GIFT_EFFECTS)
    expect(view.container.querySelector('.douyu-local-gift-source')).toHaveTextContent('x 1000000')
    tick(1_000 + LOCAL_GIFT_EFFECT_DURATION_MS)
    expect(view.container.querySelectorAll('.douyu-local-gift')).toHaveLength(0)
    state.enqueue(gift('fresh'))
    tick(1_001 + LOCAL_GIFT_EFFECT_DURATION_MS)
    expect(view.container.querySelectorAll('.douyu-local-gift')).toHaveLength(1)
  })

  it('uses the reduced-motion style and inserts untrusted names as text only', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    const node = createLocalGiftEffectNode({ messageId: 'one', senderName: '<img src=x onerror=alert(1)>', originalGift: '粉丝荧光棒', count: 2 })
    expect(node).toHaveAttribute('data-motion', 'reduced')
    expect(node.querySelector('img, script')).toBeNull()
    expect(node.querySelector('.douyu-local-gift-source')?.textContent).toBe('粉丝荧光棒 x 2 / <img src=x onerror=alert(1)>')
  })
})

describe('local visuals settings', () => {
  it('offers separate explicit opt-ins and requires an exact numeric target UID for identity', () => {
    const state = store()
    render(<SessionProvider session={state.session}><DanmakuSettingsPanel onClose={() => {}} /></SessionProvider>)
    fireEvent.click(screen.getByRole('button', { name: /^斗鱼本地视觉/ }))
    const identity = screen.getByRole('checkbox', { name: '本地幻神装扮' })
    const gifts = screen.getByRole('checkbox', { name: '荧光棒显示本地超火特效' })
    const uid = screen.getByLabelText('要装饰的斗鱼用户 ID')
    expect(identity).not.toBeChecked()
    expect(gifts).not.toBeChecked()
    expect(uid).toBeDisabled()
    expect(uid).toHaveAttribute('maxlength', '20')
    fireEvent.click(identity)
    expect(uid).toBeEnabled()
    expect(gifts).not.toBeChecked()
    fireEvent.change(uid, { target: { value: '42' } })
    expect(state.session.snapshot.settings.danmaku.localPhantomUid).toBe('42')
    fireEvent.click(gifts)
    expect(screen.getByText('样式预览 / 实际礼物仍为荧光棒')).toBeInTheDocument()
    fireEvent.click(identity)
    expect(gifts).toBeChecked()
    expect(state.session.snapshot.settings.danmaku.localPhantomUid).toBe('42')
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.queryByRole('heading', { name: '斗鱼本地视觉' })).not.toBeInTheDocument()
  })
})
