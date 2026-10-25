/**
 * Loading sources, shared by the intake screen and the source popovers.
 *
 * Per-role state (busy, last problem, resolver notes) lives in one provider rather than in
 * whichever component started the load, so closing a popover mid-resolve does not lose the
 * error that comes back.
 *
 * `routeFor` is what lets the intake screen have a single paste field: the platform of a
 * link already says which side it belongs to. Only links that carry no such hint — a bare
 * m3u8, a local file — have to be asked about.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useSession } from '../app/SessionContext'
import { parseSourceInput, toDescriptor } from '../core/mediaSources'
import type { MediaDescriptor, PlatformId, SourceRole } from '../core/types'

export interface RoleLoad {
  busy: boolean
  problem: { message: string; hint?: string } | null
  notes: string[]
}

const IDLE: RoleLoad = { busy: false, problem: null, notes: [] }

/** Which side a platform belongs to, or null when the link itself cannot say. */
export function routeFor(platform: PlatformId): SourceRole | null {
  if (platform === 'youtube' || platform === 'twitch') return 'official'
  if (platform === 'douyu' || platform === 'bilibili') return 'commentary'
  return null
}

export const ROLE_LABEL: Record<SourceRole, string> = { official: '画面', commentary: '解说' }

export const PLATFORM_LABEL: Record<PlatformId, string> = {
  youtube: 'YouTube', twitch: 'Twitch', douyu: '斗鱼', bilibili: 'B 站',
  direct: '直链', file: '本地文件', test: '测试片源',
}

interface Loader {
  state: Record<SourceRole, RoleLoad>
  /** Resolve and load whatever was typed. Resolves false when nothing was loaded. */
  loadInput: (role: SourceRole, input: string) => Promise<boolean>
  loadFile: (role: SourceRole, file: File) => Promise<void>
  loadDescriptor: (role: SourceRole, descriptor: MediaDescriptor) => Promise<void>
  clearProblem: (role: SourceRole) => void
}

const LoaderContext = createContext<Loader | null>(null)

export function SourceLoaderProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const session = useSession()
  const [state, setState] = useState<Record<SourceRole, RoleLoad>>({ official: IDLE, commentary: IDLE })
  const live = useRef(state)
  const patch = useCallback((role: SourceRole, next: Partial<RoleLoad>) => {
    live.current = { ...live.current, [role]: { ...live.current[role], ...next } }
    setState(live.current)
  }, [])

  const loadDescriptor = useCallback(async (role: SourceRole, descriptor: MediaDescriptor) => {
    patch(role, { busy: true, problem: null, notes: [] })
    try { await session.loadSource(role, descriptor) } finally { patch(role, { busy: false }) }
  }, [patch, session])

  const loadInput = useCallback(async (role: SourceRole, input: string): Promise<boolean> => {
    const parsed = parseSourceInput(input)
    if (!parsed.ok) { patch(role, { problem: { message: parsed.message } }); return false }
    if (!parsed.needsResolve) { await loadDescriptor(role, toDescriptor(parsed)); return true }

    patch(role, { busy: true, problem: null, notes: [] })
    const generation = session.beginSourceChange(role)
    try {
      const result = await apiClient.resolve(
        parsed.url, parsed.platform, role, undefined,
        session.settings.preferAdaptive || undefined,
      )
      if (generation !== session.sourceRevision(role)) return false
      if (!result.ok) { patch(role, { problem: { message: result.message } }); return false }
      if (!result.value.ok) {
        const { failure } = result.value
        patch(role, { problem: { message: failure.message, hint: failure.hint } })
        return false
      }
      const stream = result.value.stream
      patch(role, { notes: stream.notes ?? [] })
      await session.loadSource(role, {
        ...toDescriptor(
          { ...parsed, kind: stream.kind, label: stream.label },
          { url: stream.url, viaProxy: stream.requiresProxy },
        ),
        input: input.trim(),
        sourceQualities: stream.qualities,
        sourceQuality: stream.quality,
        sourceRoom: stream.sourceRoom ?? stream.danmakuRoom,
      })
      // The commentary room's danmaku come along with it; nothing to set up separately.
      if (role === 'commentary' && stream.danmakuRoom) session.connectDanmaku(stream.danmakuRoom)
      return true
    } finally {
      patch(role, { busy: false })
    }
  }, [loadDescriptor, patch, session])

  const loadFile = useCallback((role: SourceRole, file: File) => loadDescriptor(role, {
    // An object URL keeps the file local; nothing is uploaded.
    kind: 'file', url: URL.createObjectURL(file), input: file.name, label: file.name,
    loop: false, viaProxy: false, platform: 'file',
  }), [loadDescriptor])

  const clearProblem = useCallback((role: SourceRole) => patch(role, { problem: null }), [patch])

  const value = useMemo(() => ({ state, loadInput, loadFile, loadDescriptor, clearProblem }),
    [state, loadInput, loadFile, loadDescriptor, clearProblem])
  return <LoaderContext.Provider value={value}>{children}</LoaderContext.Provider>
}

export function useSourceLoader(): Loader {
  const loader = useContext(LoaderContext)
  if (!loader) throw new Error('useSourceLoader outside SourceLoaderProvider')
  return loader
}

/** The fixtures from `npm run fixtures`; offered only when they exist on this machine. */
export const FIXTURES: Record<SourceRole, MediaDescriptor> = {
  official: {
    kind: 'test', url: '/test-sources/official.mp4', input: '/test-sources/official.mp4',
    label: '测试画面', loop: true, viaProxy: false, platform: 'test',
  },
  commentary: {
    kind: 'test', url: '/test-sources/commentary.mp4', input: '/test-sources/commentary.mp4',
    label: '测试解说（晚 5 秒）', loop: true, viaProxy: false, platform: 'test',
  },
}
