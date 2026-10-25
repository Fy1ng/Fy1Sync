/**
 * One send box for the whole studio. The chat drawer types into it, and the menu on a
 * danmaku over the picture uses it too: "+1" sends through it and "回复" writes into it,
 * so a reply started over the picture is waiting in the drawer, not in a second box.
 */

import { createContext, useCallback, useContext, useState } from 'react'
import { useSessionSnapshot } from '../app/SessionContext'
import { useDouyuMessageComposer } from '../ui/DouyuMessageComposer'

type Composer = ReturnType<typeof useDouyuMessageComposer> & {
  /** Address a reply to `user`, keeping whatever was already typed after the mention. */
  reply: (user: string) => void
  /** Bumped by `reply`; the drawer moves focus to the box when it changes. */
  focusRequest: number
}

const ComposerContext = createContext<Composer | null>(null)

export function ComposerProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const { danmaku } = useSessionSnapshot()
  const composer = useDouyuMessageComposer({ connected: danmaku.connected, room: danmaku.room })
  const [focusRequest, setFocusRequest] = useState(0)
  const { draft, setDraft } = composer
  const reply = useCallback((user: string) => {
    setDraft(`@${user}：${draft.replace(/^@[^：:\s]+[：:]\s*/, '')}`)
    setFocusRequest((count) => count + 1)
  }, [draft, setDraft])
  return <ComposerContext.Provider value={{ ...composer, reply, focusRequest }}>{children}</ComposerContext.Provider>
}

export function useComposer(): Composer {
  const composer = useContext(ComposerContext)
  if (!composer) throw new Error('useComposer outside ComposerProvider')
  return composer
}
