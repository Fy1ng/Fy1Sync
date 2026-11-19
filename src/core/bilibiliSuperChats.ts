import type { BilibiliChatMessage, BilibiliSuperChatRemoval } from '../../server/danmaku/bilibiliEvents'

type DisplayedSuperChat = {
  message: BilibiliChatMessage & Required<Pick<BilibiliChatMessage, 'superChat'>>
  expiresAt: number
}

type BilibiliSuperChatState = {
  room: string
  active: DisplayedSuperChat[]
  removed: ReadonlySet<string>
}

export function createBilibiliSuperChatState(room: string): BilibiliSuperChatState {
  return { room, active: [], removed: new Set() }
}

export function updateBilibiliSuperChats(
  state: BilibiliSuperChatState, event: BilibiliChatMessage | BilibiliSuperChatRemoval, presentedAt: number,
): BilibiliSuperChatState {
  if (event.room !== state.room) return state
  const active = state.active.filter(item => item.expiresAt > presentedAt)
  if ('kind' in event) {
    const removed = new Set([...state.removed, ...event.ids].slice(-512))
    return { ...state, active: active.filter(item => !removed.has(item.message.superChat.id)), removed }
  }
  const superChat = event.superChat
  if (!superChat || state.removed.has(superChat.id) || active.some(item => item.message.superChat.id === superChat.id)) return state
  const duration = superChat.duration * 1000
  const remaining = superChat.endsAt === undefined ? duration : Math.min(duration, superChat.endsAt - event.receivedAt)
  const expiresAt = event.receivedAt + remaining
  return expiresAt > presentedAt
    ? { ...state, active: [...active, { message: { ...event, superChat }, expiresAt }].slice(-16) }
    : state
}

export function visibleBilibiliSuperChats(state: BilibiliSuperChatState, room: string, now: number): DisplayedSuperChat[] {
  return state.room === room ? state.active.filter(item => item.expiresAt > now) : []
}
