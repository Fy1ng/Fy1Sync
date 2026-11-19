import type { ReactNode } from 'react'
import { matchBilibiliLotteryMessage, type BilibiliLotteryClue, type BilibiliLotteryMessage,
  type BilibiliLotterySnapshot } from '../core/bilibiliLottery'
import './bilibiliLottery.css'

export function BilibiliLotteryMessageClue({ clue, children }: { clue: BilibiliLotteryClue; children?: ReactNode }) {
  return <details className="bilibili-lottery-message-clue">
    <summary>天选同文线索，展开原文</summary>
    <p className="muted">同文不能证明已参与</p>
    {children ?? <p className="bilibili-lottery-command">{clue.text}</p>}
  </details>
}

export function BilibiliLotteryReplayMessages({ messages, history }:
  { messages: readonly BilibiliLotteryMessage[]; history: readonly BilibiliLotterySnapshot[] }) {
  return <div className="bilibili-lottery-replay">
    {messages.map(message => {
      const clue = matchBilibiliLotteryMessage(message, history)
      return <div key={message.id} data-message-id={message.id}>
        {clue ? <BilibiliLotteryMessageClue clue={clue} /> : <p className="bilibili-lottery-command">{message.text}</p>}
      </div>
    })}
  </div>
}
