import { useState } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { EditorLocalMedia, EditorProject, EditorProjectLoaded } from '../../../electron/editorProjectContracts'
import { createEmptyHudStylePack, type HudStylePack } from '../../core/hudStylePack'
import { useEditorProject } from './useEditorProject'

const local: EditorLocalMedia = { id: 'local-one', kind: 'local', path: 'C:/samples/match.mp4', size: 100,
  sha256: 'a'.repeat(64), name: 'match.mp4', match: 'PGL / Map 2', purpose: 'validation' }
function savedProject(): EditorProject {
  const pack = createEmptyHudStylePack('saved/draft', '未发布的修改')
  pack.variants.push({ ...structuredClone(pack.variants[0]!), id: 'selected-layout' })
  return { version: 1, pack, variantId: 'selected-layout', media: [structuredClone(local)], currentMediaId: local.id }
}
function mockBridge(loaded: EditorProjectLoaded, overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    editorProjectLoad: { ok: true, value: loaded }, editorProjectSave: { ok: true, value: { ok: true } },
    editorMediaChoose: { ok: true, value: null }, ytImportList: { ok: true, value: [] }, ...overrides,
  }
  const invoke = vi.fn(async (method: string, _args?: unknown): Promise<unknown> => responses[method])
  vi.stubGlobal('streamSyncer', { invoke, subscribeDanmaku: () => () => {} } as unknown as StreamSyncerBridge)
  return { invoke, responses, saves: () => invoke.mock.calls.filter(([method]) => method === 'editorProjectSave')
    .map(([, args]) => (args as { project: EditorProject }).project) }
}
function mounted(initial = createEmptyHudStylePack(), hasCandidate = false) {
  const restorePack = vi.fn()
  const open = vi.fn()
  const hook = renderHook(() => {
    const [pack, setPack] = useState(initial)
    const [variantId, setVariantId] = useState(initial.variants[0]!.id)
    const project = useEditorProject({ pack, variantId, hasCandidate, open, restorePack: (next, id) => {
      restorePack(next, id)
      setPack(next)
      setVariantId(id)
    } })
    return { project, pack, variantId, setPack, setVariantId }
  })
  return { ...hook, restorePack, open }
}
afterEach(() => vi.unstubAllGlobals())

describe('current editor project hook', () => {
  it('keeps the initial package when no current project exists', async () => {
    const api = mockBridge({ project: null, media: null, needsRelink: false })
    const initial = createEmptyHudStylePack('new/current', '正在编辑')
    const f = mounted(initial)
    await waitFor(() => expect(f.result.current.project.ready).toBe(true))
    expect(f.restorePack).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
    expect(f.result.current.pack).toBe(initial)
    expect(f.result.current.project.current).toBeNull()
    await waitFor(() => expect(api.saves()).toHaveLength(1))
    expect(api.saves()[0]).toEqual({ version: 1, pack: initial, variantId: initial.variants[0]!.id, media: [], currentMediaId: null })
  })

  it('restores the unpublished package, current layout and authorized local media URL before autosaving', async () => {
    const project = savedProject()
    const api = mockBridge({ project, media: { id: local.id, url: 'app://app/editor-media/restored' }, needsRelink: false })
    const f = mounted()
    await waitFor(() => expect(f.result.current.project.ready).toBe(true))
    expect(f.restorePack).toHaveBeenCalledWith(project.pack, project.variantId)
    expect(f.result.current.pack).toEqual(project.pack)
    expect(f.result.current.variantId).toBe('selected-layout')
    expect(f.result.current.project.current).toEqual(local)
    expect(f.open).toHaveBeenCalledWith('app://app/editor-media/restored', local.name)
    await waitFor(() => expect(api.saves().length).toBeGreaterThan(0))
    expect(api.saves().every(saved => saved.pack.id === project.pack.id && saved.variantId === project.variantId)).toBe(true)
  })

  it('autosaves package edits, selected layout, match and purpose changes', async () => {
    const project = savedProject()
    const api = mockBridge({ project, media: null, needsRelink: false })
    const f = mounted()
    await waitFor(() => expect(f.result.current.project.ready).toBe(true))
    act(() => {
      f.result.current.setPack({ ...f.result.current.pack, name: '继续补样本', revision: 8 })
      f.result.current.setVariantId(project.pack.variants[0]!.id)
      f.result.current.project.annotate({ match: 'PGL / A vs B / Map 3', purpose: 'making' })
    })
    await waitFor(() => expect(api.saves().at(-1)).toMatchObject({
      pack: { name: '继续补样本', revision: 8 }, variantId: project.pack.variants[0]!.id, currentMediaId: local.id,
      media: [{ ...local, match: 'PGL / A vs B / Map 3', purpose: 'making' }],
    }))
    expect(f.result.current.project.current).toMatchObject({ match: 'PGL / A vs B / Map 3', purpose: 'making' })
  })

  it('retains a missing file on failed relink and reconnects only after main verifies the selected file', async () => {
    const project = savedProject()
    const api = mockBridge({ project, media: null, needsRelink: true }, {
      editorMediaChoose: { ok: false, code: 'media-mismatch', message: 'SHA-256 不一致' },
    })
    const f = mounted()
    await waitFor(() => expect(f.result.current.project.needsRelink).toBe(true))
    expect(f.open).not.toHaveBeenCalled()
    await act(async () => f.result.current.project.choose(true))
    expect(api.invoke).toHaveBeenCalledWith('editorMediaChoose', { relinkId: local.id })
    expect(f.result.current.project.error).toBe('SHA-256 不一致')
    expect(f.result.current.project.current).toEqual(local)
    expect(f.result.current.project.needsRelink).toBe(true)
    expect(f.open).not.toHaveBeenCalled()
    const relocated = { ...local, path: 'C:/samples/renamed.mp4' }
    api.responses.editorMediaChoose = { ok: true, value: { media: relocated, url: 'app://app/editor-media/relinked' } }
    await act(async () => f.result.current.project.choose(true))
    expect(f.result.current.project.current).toEqual(relocated)
    expect(f.result.current.project.needsRelink).toBe(false)
    expect(f.result.current.project.error).toBeNull()
    expect(f.open).toHaveBeenCalledWith('app://app/editor-media/relinked', local.name)
    await waitFor(() => expect(api.saves().at(-1)).toMatchObject({ media: [relocated], currentMediaId: local.id }))
  })

  it('restores YouTube media by assetId and uses its recorded display name', async () => {
    const project = savedProject()
    const downloaded = { id: 'youtube-one', kind: 'youtube' as const, assetId: 'saved-asset', name: '完整比赛 1440p', match: 'PGL / Map 1', purpose: 'validation' as const }
    project.media = [downloaded]
    project.currentMediaId = downloaded.id
    const api = mockBridge({ project, media: null, needsRelink: false }, { ytImportList: { ok: true, value: [
      { assetId: 'other-asset', state: 'ready', mediaUrl: 'app://app/admin-media/other' },
      { assetId: downloaded.assetId, state: 'ready', mediaUrl: 'app://app/admin-media/saved-asset' },
    ] } })
    const f = mounted()
    await waitFor(() => expect(f.result.current.project.ready).toBe(true))
    expect(api.invoke).toHaveBeenCalledWith('ytImportList', undefined)
    expect(f.open).toHaveBeenCalledExactlyOnceWith('app://app/admin-media/saved-asset', downloaded.name)
    expect(f.result.current.project.current).toEqual(downloaded)
  })

  it('reports an unavailable YouTube asset without opening a different download', async () => {
    const project = savedProject()
    project.media = [{ id: 'youtube-one', kind: 'youtube', assetId: 'missing-asset', name: '比赛', match: '', purpose: 'making' }]
    project.currentMediaId = 'youtube-one'
    mockBridge({ project, media: null, needsRelink: false }, { ytImportList: { ok: true, value: [
      { assetId: 'other-asset', state: 'ready', mediaUrl: 'app://app/admin-media/other' },
    ] } })
    const f = mounted()
    await waitFor(() => expect(f.result.current.project.error).toMatch(/下载素材不可用/))
    expect(f.open).not.toHaveBeenCalled()
    expect(f.result.current.project.current?.id).toBe('youtube-one')
  })

  it('keeps an explicit candidate package while restoring the saved media', async () => {
    const project = savedProject()
    const api = mockBridge({ project, media: { id: local.id, url: 'app://app/editor-media/restored' }, needsRelink: false })
    const candidate: HudStylePack = createEmptyHudStylePack('candidate/new', '从播放器编辑')
    const f = mounted(candidate, true)
    await waitFor(() => expect(f.result.current.project.ready).toBe(true))
    expect(f.restorePack).not.toHaveBeenCalled()
    expect(f.result.current.pack).toBe(candidate)
    expect(f.result.current.variantId).toBe(candidate.variants[0]!.id)
    expect(f.result.current.project.current).toEqual(local)
    expect(f.open).toHaveBeenCalledWith('app://app/editor-media/restored', local.name)
    await waitFor(() => expect(api.saves().at(-1)).toMatchObject({ pack: candidate, currentMediaId: local.id, media: [local] }))
  })

  it.each(['failure', 'rejection'])('does not overwrite the persisted project after load %s', async mode => {
    const api = mockBridge({ project: null, media: null, needsRelink: false }, {
      editorProjectLoad: { ok: false, code: 'project-failed', message: '工程读取失败' },
    })
    if (mode === 'rejection') api.invoke.mockImplementation(async method => {
      if (method === 'editorProjectLoad') throw new Error('read failed')
      return api.responses[method]
    })
    const f = mounted()
    await waitFor(() => expect(f.result.current.project.error).toMatch(/读取失败/))
    await act(async () => { f.result.current.setPack({ ...f.result.current.pack, name: '读取失败后继续编辑' }) })
    expect(api.saves()).toHaveLength(0)
  })
})

describe('autosave pacing', () => {
  it('keeps one save in flight and sends only the newest snapshot after it', async () => {
    let release: (() => void) | null = null
    const api = mockBridge({ project: null, media: null, needsRelink: false })
    api.invoke.mockImplementation(async (method: string) => {
      if (method === 'editorProjectSave') await new Promise<void>(resolve => { release = resolve })
      return api.responses[method]
    })
    const f = mounted()
    await waitFor(() => expect(api.saves()).toHaveLength(1))
    for (const name of ['一', '二', '三']) await act(async () => { f.result.current.setPack({ ...f.result.current.pack, name }) })
    expect(api.saves()).toHaveLength(1)
    await act(async () => { release!() })
    await waitFor(() => expect(api.saves()).toHaveLength(2))
    expect(api.saves()[1]!.pack.name).toBe('三')
    await act(async () => { release!() })
  })
})
