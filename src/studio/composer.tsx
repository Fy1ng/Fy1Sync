/**
 * One send box for the whole studio. The chat drawer types into it, and the menus on a
 * danmaku (over the picture or in the list) use it too: "+1" sends through it and "回复"
 * writes into it, so a reply started over the picture is waiting in the drawer, not in a
 * second box. Nothing here sends on its own: a reply or a filled favorite is a draft.
 */

import { createContext, useCallback, useContext, useState } from 'react'
import { useSessionSnapshot } from '../app/SessionContext'
import { buildReplyDraft } from '../core/messageComposition'
import { useStudioComposer, type StudioComposer } from './useStudioComposer'

type Composer = StudioComposer & {
  /** Address a reply to `user`, keeping whatever was already typed after the mention. */
  reply: (user: string) => void
  /** Put text in the box to be checked and sent by hand, e.g. a saved favorite. */
  fill: (text: string) => void
  /** Bumped by `reply` and `fill`; the drawer moves focus to the box when it changes. */
  focusRequest: number
}

const ComposerContext = createContext<Composer | null>(null)

export function ComposerProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const { danmaku } = useSessionSnapshot()
  const composer = useStudioComposer({ connected: danmaku.connected, room: danmaku.room })
  const [focusRequest, setFocusRequest] = useState(0)
  const { draft, setDraft } = composer
  const reply = useCallback((user: string) => {
    let mention: string
    try { mention = buildReplyDraft(user, '') } catch { return }
    setDraft(mention + draft.replace(/^@[^:：\s]+[:：]\s*/, ''))
    setFocusRequest((count) => count + 1)
  }, [draft, setDraft])
  const fill = useCallback((text: string) => {
    setDraft(text)
    setFocusRequest((count) => count + 1)
  }, [setDraft])
  return <ComposerContext.Provider value={{ ...composer, reply, fill, focusRequest }}>{children}</ComposerContext.Provider>
}

export function useComposer(): Composer {
  const composer = useContext(ComposerContext)
  if (!composer) throw new Error('useComposer outside ComposerProvider')
  return composer
}
