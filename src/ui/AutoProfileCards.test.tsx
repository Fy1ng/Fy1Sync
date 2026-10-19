import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { createEmptyProfile } from '../core/profileSchema'
import { initialAutoProfileState } from '../recognition/autoProfile'
import { AutoProfileCards } from './AutoProfileCards'

let session: Session
afterEach(() => { session?.dispose(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/') })

function ready() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  session = new Session({ createSampler: () => null })
  const snapshot = session.flush()
  vi.spyOn(session, 'snapshot', 'get').mockReturnValue({ ...snapshot, autoProfiles: {
    official: { ...initialAutoProfileState(), phase: 'ready', candidate: createEmptyProfile('session/official', '官方候选'), confidence: 0.94, learnedChars: ['0', '1', ':'] },
    commentary: { ...initialAutoProfileState(), phase: 'unsupported', reason: '当前识别后端不支持自动学习, 请使用手动预设' },
  } })
  render(<SessionProvider session={session}><AutoProfileCards /></SessionProvider>)
}

describe('automatic candidate sidebar', () => {
  it('exposes source-local candidate review and never saves on use', () => {
    ready()
    const use = vi.spyOn(session, 'acceptAutoProfile')
    const save = vi.spyOn(session, 'saveAutoProfile').mockResolvedValue(true)
    const official = screen.getByRole('region', { name: '官方画面自动预设' })
    expect(within(official).getByRole('img')).toHaveAccessibleName('官方画面倒计时区域预览')
    expect(official).toHaveTextContent('0 1 :')
    expect(official).toHaveTextContent('94%')
    fireEvent.click(within(official).getByRole('button', { name: '使用' }))
    expect(use).toHaveBeenCalledWith('official')
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(within(official).getByRole('button', { name: '另存为新预设' }))
    expect(save).toHaveBeenCalledWith('official')
    const commentary = screen.getByRole('region', { name: '国内解说自动预设' })
    expect(commentary).toHaveTextContent('需要手动预设')
    expect(within(commentary).queryByRole('button', { name: '使用' })).not.toBeInTheDocument()
    expect(within(commentary).getByRole('button', { name: '手动编辑' })).toBeEnabled()
  })

  it('hands the selected source to the existing editor without reloading the session', () => {
    ready()
    const edit = vi.spyOn(session, 'editAutoProfile')
    const route = vi.fn()
    window.addEventListener('popstate', route, { once: true })
    const official = screen.getByRole('region', { name: '官方画面自动预设' })
    fireEvent.click(within(official).getByRole('button', { name: '手动编辑' }))
    expect(edit).toHaveBeenCalledWith('official')
    expect(window.location.pathname).toBe('/admin')
    expect(route).toHaveBeenCalledTimes(1)
  })
})
