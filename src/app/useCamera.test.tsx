import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { Session } from './session'
import { SessionProvider } from './SessionContext'
import { setCameraStoreForTests, useCamera } from './useCamera'
import { cameraLegacyKeys, CameraStore, DEFAULT_CAMERA_WINDOW } from './camera'

let session: Session
afterEach(() => { cleanup(); session?.dispose(); setCameraStoreForTests(null) })
const crop = { x: 0.1, y: 0.2, w: 0.3, h: 0.2 }
const config = { crop, window: DEFAULT_CAMERA_WINDOW, enabled: true, updatedAt: 1 }
async function setup(input = '6657', sourceRoom: string | undefined = '6979222') {
  session = new Session({ createSampler: () => null })
  const store = new CameraStore(null)
  setCameraStoreForTests(store)
  await session.loadSource('commentary', { input, sourceRoom, platform: 'douyu', label: '斗鱼 6979222', kind: 'progressive', url: 'app://app/media/fixture', loop: false, viaProxy: false })
  return { store, view: () => renderHook(useCamera, { wrapper: ({ children }) => <SessionProvider session={session}>{children}</SessionProvider> }) }
}
describe('camera follows confirmed video identity', () => {
  it('shares alias and canonical source settings and ignores independent chat changes', async () => {
    const { store, view } = await setup()
    const hook = view()
    expect(hook.result.current.room).toBe('douyu:6979222')
    act(() => hook.result.current.save(crop))
    expect(store.get('douyu:6979222')?.crop).toEqual(crop)
    act(() => { session.connectDanmaku('1234'); session.flush() })
    expect(session.snapshot.danmaku.room).toBe('1234')
    expect(hook.result.current.room).toBe('douyu:6979222')
    await act(() => session.loadSource('commentary', { ...session.engine.getState().commentary.descriptor!, input: '6979222' }))
    expect(hook.result.current.config?.crop).toEqual(crop)
  })
  it('copies confirmed legacy alias settings without deleting or overriding canonical records', async () => {
    const { store, view } = await setup('https://douyu.com/6657')
    store.set('douyu:6657', config)
    const hook = view()
    expect(hook.result.current.config?.crop).toEqual(crop)
    expect(store.get('douyu:6657')).toEqual(store.get('douyu:6979222'))
    store.set('douyu:6979222', { ...config, enabled: false })
    hook.unmount()
    expect(view().result.current.config?.enabled).toBe(false)
    expect(store.get('douyu:6657')?.enabled).toBe(true)
  })
  it('does not guess mappings when the video identity is unconfirmed', async () => {
    expect(cameraLegacyKeys({ platform: 'douyu', input: '6657' })).toEqual([])
    const { store, view } = await setup('6657')
    await session.loadSource('commentary', { ...session.engine.getState().commentary.descriptor!, sourceRoom: undefined })
    store.set('douyu:6979222', config)
    expect(view().result.current.config).toBeNull()
    expect(store.get('douyu:6657')).toBeNull()
  })
  it('keeps explicit removal effective after alias compatibility copying', async () => {
    const { store, view } = await setup()
    store.set('douyu:6657', config)
    const hook = view()
    expect(hook.result.current.config).not.toBeNull()
    act(() => hook.result.current.remove())
    expect(hook.result.current.config).toBeNull()
    hook.unmount()
    expect(view().result.current.config).toBeNull()
  })
  it('preserves an existing canonical configuration loaded using the real ID', async () => {
    const { store, view } = await setup('6979222')
    store.set('douyu:6979222', config)
    expect(view().result.current.config?.crop).toEqual(crop)
  })
})


it('restores the legacy room fallback for a local source without confirmed sourceRoom', async () => {
  const { store, view } = await setup()
  await session.loadSource('commentary', { ...session.engine.getState().commentary.descriptor!, platform: 'direct', input: '/test-sources/commentary.mp4', sourceRoom: undefined })
  store.set('direct:6979222', config)
  session.connectDanmaku('6979222')
  session.flush()
  const hook = view()
  expect(hook.result.current.room).toBe('direct:6979222')
  expect(hook.result.current.config?.crop).toEqual(crop)
})
