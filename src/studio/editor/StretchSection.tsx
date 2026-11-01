/** Scan a stretch through Rust; only reviewed glyph bitmaps are kept. */

import { useEffect, useRef, useState } from 'react'
import type { HudFieldId, HudStylePack } from '../../core/hudStylePack'
import { prepareHudGlyphs } from '../../core/hudWasm'
import { FrameGrabber, FULL_FRAME_ROI } from '../../recognition/frameGrabber'
import { pairReading } from './reading'
import { drawMask } from './framePipeline'
import { proposeStretch, stretchSamples, type StretchFrame, type StretchGroup, type StretchSample } from './stretch'
import { editorVariant } from './layoutModel'

/** Slow enough that the page presents nearly every frame while each is grabbed. */
const SCAN_RATE = 0.25
/** Longest stretch one scan takes: a minute is 3 600 frames at 60 fps. */
const MAX_STRETCH_SECONDS = 60

const STATE_TEXT = { proposed: '', 'box-mismatch': '字符框数不对', unsure: '待确认', pending: '待确认' } as const

function GroupPicture({ frame }: { frame: StretchFrame }): React.ReactNode {
  return <canvas className="stretch-pic" ref={(node) => drawMask(node, frame.binary)} />
}

export function StretchSection({ video, pack, variantId, onSave, fieldId = 'clock' }: {
  fieldId?: HudFieldId
  variantId?: string
  /** The loaded recording, or null while none is (a screenshot, or nothing). */
  video: HTMLVideoElement | null
  pack: HudStylePack
  /** Store the reviewed samples. */
  onSave: (samples: StretchSample[]) => void
}): React.ReactNode {
  const [mark, setMark] = useState<{ in: number | null; out: number | null }>({ in: null, out: null })
  const [first, setFirst] = useState('')
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null)
  const [frames, setFrames] = useState<StretchFrame[]>([])
  const [groups, setGroups] = useState<StretchGroup[]>([])
  const [kept, setKept] = useState<boolean[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const cancel = useRef<(() => void) | null>(null)
  const currentVariant = editorVariant(pack, variantId)
  const grammar = currentVariant.fields[fieldId]?.grammar
  const format = grammar?.kind === 'countdown' ? grammar.format : 'm:ss'
  useEffect(() => () => cancel.current?.(), [video, pack, fieldId, variantId])

  const length = mark.in !== null && mark.out !== null ? mark.out - mark.in : null
  const markProblem = length === null ? null : length <= 0 ? '出点要在入点之后'
    : length > MAX_STRETCH_SECONDS ? `一次最多 ${MAX_STRETCH_SECONDS} 秒` : null

  const run = async (): Promise<void> => {
    if (!video || mark.in === null || mark.out === null || markProblem || !first.trim() || cancel.current) return
    setProblem(null)
    setGroups([])
    setFrames([])
    setScan({ done: 0, total: mark.out - mark.in })
    const grabber = new FrameGrabber()
    const collected: StretchFrame[] = []
    const from = mark.in, to = mark.out
    const rate = video.playbackRate
    let stopped = false
    let completed = false
    let handle: number | null = null
    let scanError: string | null = null
    let releaseSeek = (): void => {}
    let resolveScan = (): void => {}
    const finished = new Promise<void>(resolve => { resolveScan = resolve })
    const finish = (): void => { completed = true; releaseSeek(); resolveScan() }
    const stop = (): void => { stopped = true; finish() }
    const onEnded = (): void => finish()
    const onError = (): void => { scanError = '视频解码失败, 无法扫描这一段'; finish() }
    cancel.current = stop
    video.addEventListener('ended', onEnded)
    video.addEventListener('error', onError)
    try {
      video.pause()
      // A callback registered before seeking can carry the previous frame's metadata while
      // readyState is still HAVE_METADATA. Wait for the new decoded frame before subscribing.
      const ready = await new Promise<boolean>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let settled = false
        let pendingSeek = Math.abs(video.currentTime - from) > 1e-6 || video.seeking
        const cleanup = (): void => {
          if (timer !== undefined) clearTimeout(timer)
          for (const event of ['seeked', 'loadeddata', 'canplay']) video.removeEventListener(event, check)
        }
        const done = (value: boolean): void => {
          if (settled) return
          settled = true
          cleanup()
          resolve(value)
        }
        const check = (event?: Event): void => {
          if (event?.type === 'seeked') pendingSeek = false
          if (!pendingSeek && !video.seeking && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) done(true)
        }
        releaseSeek = () => done(false)
        for (const event of ['seeked', 'loadeddata', 'canplay']) video.addEventListener(event, check)
        timer = setTimeout(() => {
          scanError = '取帧失败: no-video-frame, 等待跳转后的解码画面超时'
          done(false)
        }, 15_000)
        if (pendingSeek) video.currentTime = from
        check()
      })
      releaseSeek = () => {}
      if (ready && !completed) {
        const onFrame = async (_now: number, meta: VideoFrameCallbackMetadata): Promise<void> => {
          if (completed) return
          if (meta.mediaTime > to + 1e-3) { finish(); return }
          if (meta.mediaTime >= from - 1e-3) {
            try {
              const grabbed = grabber.grab(video, FULL_FRAME_ROI, meta.mediaTime)
              if (!grabbed.ok) throw new Error(`取帧失败: ${grabbed.reason}`)
              const prepared = await prepareHudGlyphs(grabbed.frame, pack, currentVariant.id, undefined, fieldId)
              if (completed) return
              if (collected.length === 0 || meta.mediaTime > collected[collected.length - 1]!.at + 1e-4) {
                collected.push({ at: meta.mediaTime, binary: prepared.binary, boxes: prepared.boxes, bitmaps: prepared.bitmaps })
              }
            } catch (error) {
              scanError = error instanceof Error ? error.message : String(error)
              finish()
              return
            }
            setScan({ done: Math.max(0, meta.mediaTime - from), total: to - from })
          }
          if (!completed) handle = video.requestVideoFrameCallback(onFrame)
        }
        handle = video.requestVideoFrameCallback(onFrame)
        video.playbackRate = SCAN_RATE
        void video.play().catch(error => {
          if (!completed) { scanError = `无法播放扫描片段: ${error instanceof Error ? error.message : String(error)}`; finish() }
        })
        await finished
      }
    } catch (error) {
      scanError = error instanceof Error ? error.message : String(error)
    } finally {
      completed = true
      releaseSeek()
      if (handle !== null) video.cancelVideoFrameCallback(handle)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('error', onError)
      video.pause()
      video.playbackRate = rate
      grabber.dispose()
      if (cancel.current === stop) cancel.current = null
      setScan(null)
    }
    if (stopped) return
    if (scanError) { setProblem(scanError); return }
    if (collected.length === 0) { setProblem('这一段没有取到画面'); return }
    const proposal = proposeStretch(collected, first, format, fieldId)
    setFrames(collected)
    setGroups(proposal)
    setKept(proposal.map((group) => group.state === 'proposed'))
  }

  const keptSamples = (): StretchSample[] => stretchSamples(frames, groups, (group) => kept[groups.indexOf(group)] === true, fieldId)
  const save = (): void => {
    const samples = keptSamples()
    if (samples.length === 0) { setProblem('没有可存的样本：勾选至少一组，并确认它的读数和字符框数一致'); return }
    onSave(samples)
    setGroups([])
    setFrames([])
  }
  const edit = (index: number, text: string): void => {
    const valid = pairReading(text, frames[groups[index]!.sample]!.boxes.length, fieldId).ok
    setGroups((current) => current.map((group, at) => at === index ? { ...group, text,
      state: valid ? 'proposed' : 'box-mismatch', note: undefined } : group))
    // A valid typed reading confirms this group; invalid input cannot become a sample.
    setKept((current) => current.map((value, at) => at === index ? valid : value))
  }

  const clock = (time: number | null): string => time === null ? '' : ` ${time.toFixed(2)}s`

  return (
    <section className="rail-group" aria-label="整段标注">
      <div className="rail-head">
        <h2>整段标注</h2>
        <span className="rail-meta">{fieldId === 'clock' ? '倒计时每秒减 1' : '比分变化提议 + 1, 逐组确认'}</span>
      </div>
      {!video ? (
        <p className="muted">载入录像后，标出一段并填写第一帧的读数，一次存下整段的字符样本</p>
      ) : (
        <>
          <div className="stretch-marks">
            <button type="button" className="btn-quiet small" disabled={scan !== null}
              onClick={() => setMark((m) => ({ ...m, in: video.currentTime }))}>设为入点{clock(mark.in)}</button>
            <button type="button" className="btn-quiet small" disabled={scan !== null}
              onClick={() => setMark((m) => ({ ...m, out: video.currentTime }))}>设为出点{clock(mark.out)}</button>
          </div>
          {markProblem && <p className="form-error">{markProblem}</p>}
          <form className="reading-row" onSubmit={(event) => { event.preventDefault(); void run() }}>
            <input className="text-input num" value={first} aria-label="入点读数" placeholder={fieldId === 'clock' ? '入点那一帧的读数，例如 1:49' : '入点那一帧的比分, 例如 8'}
              spellCheck={false} autoComplete="off" inputMode="numeric" disabled={scan !== null}
              onChange={(event) => setFirst(event.target.value)} />
            {scan ? (
              <button type="button" className="btn-quiet small" onClick={() => cancel.current?.()}>停止</button>
            ) : (
              <button type="submit" className="btn-solid small" disabled={length === null || markProblem !== null || !first.trim()}>扫描这一段</button>
            )}
          </form>
          {scan && <p className="muted" role="status">正在扫描 {scan.done.toFixed(1)} / {scan.total.toFixed(1)} 秒</p>}
          {problem && <p className="form-error" role="alert">{problem}</p>}
          {groups.length > 0 && (
            <>
              {groups.some((group) => group.state === 'box-mismatch') && (
                <p className="note-warn">有 {groups.filter((group) => group.state === 'box-mismatch').length} 组字符框数不对，多半是字符粘连或断开：调整阈值或识别区域后重新扫描</p>
              )}
              <ul className="stretch-groups" aria-label="扫描结果">
                {groups.map((group, index) => (
                  <li key={`${group.from}-${index}`} className="stretch-group" data-state={group.state}>
                    <input type="checkbox" checked={kept[index] === true} aria-label={`存入 ${group.text || '这一组'}`}
                      onChange={(event) => {
                        const checked = event.target.checked
                        const valid = pairReading(group.text, frames[group.sample]!.boxes.length, fieldId).ok
                        setKept(current => current.map((value, at) => at === index ? checked && valid : value))
                        if (checked && valid) setGroups(current => current.map((item, at) => at === index ? { ...item, state: 'proposed', note: undefined } : item))
                      }} />
                    <GroupPicture frame={frames[group.sample]!} />
                    <input className="text-input num stretch-text" value={group.text} aria-label={`${group.from.toFixed(2)}s 起的读数`}
                      onChange={(event) => edit(index, event.target.value)} />
                    <span className="muted num">{group.frames} 帧</span>
                    {group.state !== 'proposed' && <span className="stretch-note" title={group.note}>{STATE_TEXT[group.state]}</span>}
                  </li>
                ))}
              </ul>
              <div className="stretch-actions">
                <button type="button" className="btn-solid small" onClick={save}>存入勾选的 {kept.filter(Boolean).length} 组</button>
                <button type="button" className="btn-quiet small" onClick={() => { setGroups([]); setFrames([]) }}>放弃</button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
