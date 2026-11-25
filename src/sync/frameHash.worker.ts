import { fingerprint, matchFrames, WIDTH, HEIGHT, type HashFrame } from './frameHashCore.mjs'
import type { HashRequest, HashResponse } from './frameHashProtocol'
import type { SourceRole } from '../core/types'

interface Frame extends HashFrame { wall: number }
const buffers = { official: [] as Frame[], commentary: [] as Frame[] }
const history = { official: [] as Frame[], commentary: [] as Frame[] }
const epochs = { official: '', commentary: '' }
let since = -Infinity
function send(message: HashResponse): void { postMessage(message) }
function reset(role: SourceRole): void { buffers[role] = []; history[role] = []; epochs[role] = '' }

self.onmessage = (event: MessageEvent<HashRequest>) => {
  const request = event.data
  try {
    if (request.type === 'reset') {
      for (const role of request.role ? [request.role] : ['official', 'commentary'] as const) reset(role)
    } else if (request.type === 'fresh') {
      since = request.since
    } else if (request.type === 'frame') {
      const { role, pts, wall, epoch, width, height, pixels } = request
      if (epochs[role] !== epoch || (buffers[role].length && pts <= buffers[role].at(-1)!.pts)) reset(role)
      epochs[role] = epoch
      if (width * height * 4 !== pixels.length || width * height > 131072) throw new Error('画面取样尺寸无效')
      const gray = new Uint8Array(WIDTH * HEIGHT)
      for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
        const index = (Math.min(height - 1, Math.floor((y + 0.5) * height / HEIGHT)) * width
          + Math.min(width - 1, Math.floor((x + 0.5) * width / WIDTH))) * 4
        gray[y * WIDTH + x] = Math.round(pixels[index]! * 0.299 + pixels[index + 1]! * 0.587 + pixels[index + 2]! * 0.114)
      }
      const frame = { pts, wall, fp: fingerprint(gray, request.masks.map(r => ({ x: r.x, y: r.y, width: r.w, height: r.h }))) }
      buffers[role].push(frame)
      while (buffers[role].length > 720 || pts - buffers[role][0]!.pts > 12) buffers[role].shift()
      if (!history[role].length || pts - history[role].at(-1)!.pts >= 0.19) history[role].push(frame)
      while (history[role].length > 400 || pts - history[role][0]!.pts > 75) history[role].shift()
      send({ type: 'ack', role })
    } else {
      const a = buffers.official.filter(f => !request.fresh || f.wall >= since)
      const b = buffers.commentary.filter(f => !request.fresh || f.wall >= since)
      // Readback can skip different frames per role. A wider temporal baseline
      // compares sustained motion without requiring identical adjacent gaps.
      let result = matchFrames(a, b, { temporalStep: 3 })
      let coarse = false
      if (result.status !== 'ok' && !request.fresh) {
        const found = matchFrames(history.official, history.commentary,
          { stepTolerance: 0.25, maxDetail: 0.075, minSpan: 1.5, temporalStep: 3 })
        if (found.status === 'ok') { result = found; coarse = true }
      }
      const spanOf = (frames: Frame[]): number => frames.length >= 2 ? Math.max(0, frames.at(-1)!.pts - frames[0]!.pts) : 0
      send({ type: 'result', id: request.id, match: result,
        counts: { official: a.length, commentary: b.length },
        historySpan: { official: spanOf(history.official), commentary: spanOf(history.commentary) },
        coarse })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '画面匹配失败'
    send({ type: 'error', message: message === 'insufficient visible area'
      ? '忽略区域过大，请至少保留四分之一画面' : message })
    if (request.type === 'frame') send({ type: 'ack', role: request.role })
  }
}
