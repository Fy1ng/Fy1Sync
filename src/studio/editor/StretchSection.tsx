/**
 * 整段标注: mark a stretch of the loaded recording, type the reading on its first frame,
 * scan it, review the proposed reading for each run of identical frames, and save.
 *
 * The scan plays the stretch slowly and grabs only the recognition region of every frame
 * the page presents, so a 4K recording costs a few kilobytes a frame, not 33 MB.
 */

import { useRef, useState } from 'react'
import type { RecognitionProfile } from '../../core/profileSchema'
import { binarize, cropBinary, toGrayscale } from '../../core/imageOps'
import { segmentGlyphs } from '../../core/segmentation'
import { FrameGrabber } from '../../recognition/frameGrabber'
import { drawMask } from './framePipeline'
import { proposeStretch, stretchSamples, type StretchFrame, type StretchGroup, type StretchSample } from './stretch'

/** Slow enough that the page presents nearly every frame while each is grabbed. */
const SCAN_RATE = 0.25
/** Longest stretch one scan takes: a minute is 3 600 frames at 60 fps. */
const MAX_STRETCH_SECONDS = 60

const STATE_TEXT = { proposed: '', 'box-mismatch': '字符框数不对', unsure: '待确认' } as const

function GroupPicture({ frame }: { frame: StretchFrame }): React.ReactNode {
  return <canvas className="stretch-pic" ref={(node) => drawMask(node, frame.binary)} />
}

export function StretchSection({ video, profile, onSave }: {
  /** The loaded recording, or null while none is (a screenshot, or nothing). */
  video: HTMLVideoElement | null
  profile: RecognitionProfile
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
  const format = profile.clockFormat === 'auto' ? 'm:ss' : profile.clockFormat

  const length = mark.in !== null && mark.out !== null ? mark.out - mark.in : null
  const markProblem = length === null ? null : length <= 0 ? '出点要在入点之后'
    : length > MAX_STRETCH_SECONDS ? `一次最多 ${MAX_STRETCH_SECONDS} 秒` : null

  const run = async (): Promise<void> => {
    if (!video || mark.in === null || mark.out === null || markProblem || !first.trim()) return
    setProblem(null)
    setGroups([])
    setFrames([])
    const grabber = new FrameGrabber()
    const collected: StretchFrame[] = []
    const from = mark.in, to = mark.out
    let stopped = false
    let handle = 0
    const finish = new Promise<void>((resolve) => {
      cancel.current = () => { stopped = true; resolve() }
      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata): void => {
        if (stopped) return
        if (meta.mediaTime > to + 1e-3) { resolve(); return }
        if (meta.mediaTime >= from - 1e-3) {
          const grabbed = grabber.grab(video, profile.roi, meta.mediaTime)
          if (grabbed.ok) {
            const { pixels, width, height } = grabbed.frame
            const binary = binarize(cropBinary(toGrayscale(pixels, width, height), { x: 0, y: 0, width, height }), profile.preprocess)
            // Same frame presented twice (a slow decode): keep the first.
            if (collected.length === 0 || meta.mediaTime > collected[collected.length - 1]!.at + 1e-4) {
              collected.push({ at: meta.mediaTime, binary, boxes: segmentGlyphs(binary).boxes })
            }
          }
          setScan({ done: Math.max(0, meta.mediaTime - from), total: to - from })
        }
        handle = video.requestVideoFrameCallback(onFrame)
      }
      handle = video.requestVideoFrameCallback(onFrame)
      video.addEventListener('ended', () => resolve(), { once: true })
    })
    const rate = video.playbackRate
    video.pause()
    video.currentTime = from
    await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }))
    setScan({ done: 0, total: to - from })
    video.playbackRate = SCAN_RATE
    void video.play().catch(() => cancel.current?.())
    await finish
    video.cancelVideoFrameCallback(handle)
    video.pause()
    video.playbackRate = rate
    grabber.dispose()
    cancel.current = null
    setScan(null)
    if (stopped) return
    if (collected.length === 0) { setProblem('这一段没有取到画面'); return }
    const proposal = proposeStretch(collected, first, format)
    setFrames(collected)
    setGroups(proposal)
    setKept(proposal.map((group) => group.state === 'proposed'))
  }

  const keptSamples = (): StretchSample[] => stretchSamples(frames, groups, (group) => kept[groups.indexOf(group)] === true)
  const save = (): void => {
    const samples = keptSamples()
    if (samples.length === 0) { setProblem('没有可存的样本：勾选至少一组，并确认它的读数和字符框数一致'); return }
    onSave(samples)
    setGroups([])
    setFrames([])
  }
  const edit = (index: number, text: string): void => {
    setGroups((current) => current.map((group, at) => at === index ? { ...group, text } : group))
    // A typed reading is the viewer's word for it: keep it unless they untick it.
    setKept((current) => current.map((value, at) => at === index ? text.trim() !== '' : value))
  }

  const clock = (time: number | null): string => time === null ? '' : ` ${time.toFixed(2)}s`

  return (
    <section className="rail-group" aria-label="整段标注">
      <div className="rail-head">
        <h2>整段标注</h2>
        <span className="rail-meta">倒计时每秒减 1</span>
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
            <input className="text-input num" value={first} aria-label="入点读数" placeholder="入点那一帧的读数，例如 1:49"
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
                      onChange={(event) => setKept((current) => current.map((value, at) => at === index ? event.target.checked : value))} />
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
