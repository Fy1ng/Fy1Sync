/** The editor is local; main still validates every published profile. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import { Session } from '../../app/session'
import { SessionProvider } from '../../app/SessionContext'
import AdminPage from './AdminPage'
import { apiClient } from '../../app/apiClient'
import { profileStore } from '../../core/profileStore'
import { CLOCK_CHARS, createEmptyProfile, TEMPLATE_PIXELS } from '../../core/profileSchema'
import { packBitmap } from '../../core/bitmapCodec'

const sessions: Session[] = []

afterEach(() => {
  cleanup()
  sessions.splice(0).forEach((session) => session.dispose())
  vi.unstubAllGlobals()
})

describe('AdminPage desktop entry', () => {
  it('opens directly and shows main-process write validation without a token gate', async () => {
    const invoke = vi.fn(async (method: string) => method === 'listPresets'
      ? { ok: true, value: { presets: [] } }
      : { ok: false, code: 'invalid-profile', message: '配置校验未通过', detail: { issues: [{ path: 'roi.w', message: '必须大于 0' }] } },
    ) as StreamSyncerBridge['invoke']
    vi.stubGlobal('streamSyncer', { invoke, subscribeDanmaku: () => () => {} } satisfies StreamSyncerBridge)
    const session = new Session({ createSampler: () => null })
    sessions.push(session)
    render(<SessionProvider session={session}><AdminPage /></SessionProvider>)
    expect(screen.getByRole('heading', { name: '配置编辑器' })).toBeInTheDocument()
    expect(screen.queryByLabelText('管理令牌')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '发布到本机' }))
    expect(await screen.findByRole('status')).toHaveTextContent('roi.w 必须大于 0')
    expect(invoke).toHaveBeenCalledWith('savePreset', expect.objectContaining({ token: '', etag: undefined }))
    expect(vi.mocked(invoke).mock.calls.some(([method]) => method === 'verifyAdmin')).toBe(false)
  })
})

describe('publish conflicts', () => {
  it('offers reload and an overwrite that only beats the reported version', async () => {
    const calls: Array<{ method: string; args: unknown }> = []
    let attempt = 0
    const invoke = vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      if (method === 'listPresets') return { ok: true, value: { presets: [] } }
      if (method === 'savePreset') {
        attempt += 1
        return attempt === 1
          ? { ok: false, code: 'conflict', message: '预设已被其他会话修改', detail: { currentEtag: 'etag-theirs' } }
          : { ok: true, value: { id: 'x', etag: 'etag-mine', updatedAt: 1 } }
      }
      return { ok: false, code: 'not-found', message: '未知' }
    }) as StreamSyncerBridge['invoke']
    vi.stubGlobal('streamSyncer', { invoke, subscribeDanmaku: () => () => {} } satisfies StreamSyncerBridge)
    const session = new Session({ createSampler: () => null })
    sessions.push(session)
    render(<SessionProvider session={session}><AdminPage /></SessionProvider>)

    fireEvent.click(screen.getByRole('button', { name: '发布到本机' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('已在别处被修改')
    expect(screen.getByRole('button', { name: '载入对方版本（放弃本次修改）' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '用我的版本覆盖' }))
    expect(await screen.findByRole('status')).toHaveTextContent('已发布为本机预设')
    const saves = calls.filter((call) => call.method === 'savePreset')
    expect(saves).toHaveLength(2)
    expect(saves[1]!.args).toEqual(expect.objectContaining({ etag: 'etag-theirs' }))
  })
})

async function editingPublishedProfile() {
  const profile = createEmptyProfile('test/published', 'Original')
  profile.templates = Object.fromEntries(CLOCK_CHARS.map(char => [char, [{
    id: char, data: packBitmap(new Uint8Array(TEMPLATE_PIXELS).fill(255)), createdAt: 1,
  }]]))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.spyOn(apiClient, 'listPresets').mockResolvedValue({ ok: true, value: { presets: [
    { id: profile.id, name: profile.name, etag: 'original-etag', templateChars: 11, updatedAt: 1 },
  ] } })
  const read = vi.spyOn(apiClient, 'getPreset').mockResolvedValue({ ok: true, value: { profile, etag: 'original-etag' } })
  vi.spyOn(profileStore, 'list').mockResolvedValue([])
  const draft = vi.spyOn(profileStore, 'save').mockImplementation(async value => ({ profile: value, id: value.id, updatedAt: 2 }))
  const publish = vi.spyOn(apiClient, 'savePreset').mockResolvedValue({ ok: true, value: { id: profile.id, etag: 'new-etag', updatedAt: 3 } })
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  render(<SessionProvider session={session}><AdminPage /></SessionProvider>)
  fireEvent.click(await screen.findByRole('button', { name: /Original/ }))
  await waitFor(() => expect(screen.getByLabelText('名称')).toHaveValue('Original'))
  return { profile, session, draft, publish, read }
}

describe('editor saved and published state', () => {
  it('keeps a saved draft unpublishable until the edited content is actually published', async () => {
    const { session, publish } = await editingPublishedProfile()
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Draft only' } })
    fireEvent.click(screen.getByRole('button', { name: '存为草稿' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已保存到本机草稿'))
    fireEvent.click(screen.getByRole('button', { name: '应用到播放器' }))
    expect(screen.getByRole('status')).toHaveTextContent('请先')
    expect(session.profileFor('official')).toBeNull()
    expect(publish).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '发布到本机' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已发布为本机预设'))
    fireEvent.click(screen.getByRole('button', { name: '应用到播放器' }))
    expect(session.profileFor('official')?.name).toBe('Draft only')
  })

  it('prevents duplicate publication and retains edits made while publishing', async () => {
    const { publish, session, profile } = await editingPublishedProfile()
    let finish!: (value: Awaited<ReturnType<typeof apiClient.savePreset>>) => void
    publish.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Submitted' } })
    const button = screen.getByRole('button', { name: '发布到本机' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '存为草稿' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'New edits' } })
    await act(async () => finish({ ok: true, value: { id: profile.id, etag: 'submitted-etag', updatedAt: 4 } }))
    expect(screen.getByLabelText('名称')).toHaveValue('New edits')
    expect(screen.getByRole('status')).toHaveTextContent('当前还有未发布的修改')
    expect(screen.getByRole('heading', { name: '配置编辑器' }).closest('header')).toHaveTextContent('未保存')
    fireEvent.click(screen.getByRole('button', { name: '应用到播放器' }))
    expect(session.profileFor('official')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '发布到本机' }))
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(2))
    expect(publish.mock.calls[1]).toEqual([profile.id, expect.objectContaining({ name: 'New edits' }), '', 'submitted-etag'])
  })

  it('does not mark newer edits as saved when an older draft write finishes', async () => {
    const { draft, profile } = await editingPublishedProfile()
    let finish!: (value: Awaited<ReturnType<typeof profileStore.save>>) => void
    draft.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Saved draft' } })
    fireEvent.click(screen.getByRole('button', { name: '存为草稿' }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Unsaved changes' } })
    await act(async () => finish({ id: profile.id, profile: draft.mock.calls[0]![0], updatedAt: 4 }))
    expect(screen.getByLabelText('名称')).toHaveValue('Unsaved changes')
    expect(screen.getByRole('status')).toHaveTextContent('当前还有未保存的修改')
    expect(screen.getByRole('heading', { name: '配置编辑器' }).closest('header')).toHaveTextContent('未保存')
  })

  it('does not apply late publication metadata to a newly created document', async () => {
    const { publish, profile } = await editingPublishedProfile()
    let finish!: (value: Awaited<ReturnType<typeof apiClient.savePreset>>) => void
    publish.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '发布到本机' }))
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    await act(async () => finish({ ok: true, value: { id: profile.id, etag: 'obsolete-etag', updatedAt: 4 } }))
    expect(screen.getByLabelText('标识')).toHaveValue('custom/untitled')
    fireEvent.click(screen.getByRole('button', { name: '发布到本机' }))
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(2))
    expect(publish.mock.calls[1]?.[3]).toBeUndefined()
  })

  it('keeps current edits when an earlier preset read returns late', async () => {
    const { read, profile } = await editingPublishedProfile()
    let finish!: (value: Awaited<ReturnType<typeof apiClient.getPreset>>) => void
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: /Original/ }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Kept edits' } })
    await act(async () => finish({ ok: true, value: { profile, etag: 'old' } }))
    expect(screen.getByLabelText('名称')).toHaveValue('Kept edits')
  })
})
