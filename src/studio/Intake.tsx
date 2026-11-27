/**
 * The first screen: one field, and under it the two sides. The viewer picks 画面 or 解说
 * first, then types into the field for that side; nothing is sorted by guessing from the
 * link. A bare room number asks for its platform as soon as it is typed, without waiting
 * for Enter.
 *
 * It steps aside as soon as a source presents a frame, and can always be skipped: settings, the
 * Douyu desk and a single source are all reachable from the player without both links.
 */

import { useEffect, useRef, useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { EMPTY_DIRECT_DRAFT, hasDirectOptions, parseDirectDraft, type DirectStreamDraft } from '../core/directStream'
import { SOURCE_ROLES, type SourceRole } from '../core/types'
import { DirectStreamFields } from './DirectStreamFields'
import { Icon } from './kit'
import { LoginOffer, PLATFORM_LABEL, ROLE_LABEL, SOURCE_HINT, SOURCE_KINDS, SourceIssue, parseRoomInput, sourceTitle, useSourceLoader, type RoomPlatform } from './sources'

const ROOM_PLATFORMS: RoomPlatform[] = ['douyu', 'bilibili', 'huya', 'douyin']

export function Intake({ onClose, onSchedule, onFavorites }: {
  onClose: () => void
  /** Open 赛程, to pick the official broadcast by match. */
  onSchedule: () => void
  onFavorites?: () => void
}): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const media = snapshot.media
  // The side being filled. None until the viewer picks; the field waits for that.
  const [role, setRole] = useState<SourceRole | null>(null)
  const [text, setText] = useState('')
  const [roomPlatform, setRoomPlatform] = useState<RoomPlatform | null>(null)
  const [directDraft, setDirectDraft] = useState<DirectStreamDraft>({ ...EMPTY_DIRECT_DRAFT })
  const [directOpen, setDirectOpen] = useState(false)
  const [directProblem, setDirectProblem] = useState<string | null>(null)
  const [restoreSucceeded, setRestoreSucceeded] = useState(false)
  const draftRevision = useRef(0)
  const [pendingSubmissions, setPendingSubmissions] = useState(0)
  const field = useRef<HTMLInputElement | null>(null)
  const picturesAtOpen = useRef<Record<SourceRole, number | null>>({
    official: media.official.firstFrame ? session.sourceRevision('official') : null,
    commentary: media.commentary.firstFrame ? session.sourceRevision('commentary') : null,
  })
  const pictureVisible = SOURCE_ROLES.some(side => media[side].status === 'ready' && media[side].firstFrame
    && picturesAtOpen.current[side] !== session.sourceRevision(side))
  const anyLoaded = SOURCE_ROLES.some((side) => media[side].status !== 'empty')
  const anyBusy = SOURCE_ROLES.some((side) => loader.state[side].busy)
  const bare = parseRoomInput(text)?.platform === null ? parseRoomInput(text)!.room : null
  const canSubmit = role !== null && text.trim() !== '' && (bare === null || roomPlatform !== null) && !loader.state[role].busy

  useEffect(() => { if (role) field.current?.focus() }, [role])
  // Escape leaves from anywhere: after a choice button disappears, focus is no longer inside.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // Reveal the first picture while the other source and synchronization keep preparing.
  useEffect(() => {
    if ((pictureVisible || restoreSucceeded) && !text.trim() && !anyBusy && pendingSubmissions === 0 && !loader.restoring) onClose()
  }, [pictureVisible, restoreSucceeded, text, anyBusy, pendingSubmissions, loader.restoring, onClose])

  const pick = (next: SourceRole): void => {
    if (next !== role) draftRevision.current++
    setRole(next)
    setDirectProblem(null)
    loader.clearProblem(next)
  }
  const submit = (): void => {
    if (!canSubmit || !role) return
    const parsedDirect = parseDirectDraft(directDraft)
    if (!parsedDirect.ok) {
      setDirectProblem(parsedDirect.message)
      setDirectOpen(true)
      return
    }
    setDirectProblem(null)
    const side = role
    const revision = draftRevision.current
    const submittedText = text
    const submittedPlatform = roomPlatform
    const submittedDraft = directDraft
    setText('')
    setRoomPlatform(null)
    setDirectDraft({ ...EMPTY_DIRECT_DRAFT })
    setDirectOpen(false)
    setPendingSubmissions(count => count + 1)
    void loader.loadInput(
      side,
      submittedText.trim(),
      bare !== null ? submittedPlatform! : undefined,
      ...(hasDirectOptions(parsedDirect.options) ? [parsedDirect.options] : []),
    ).then((ok) => {
      if (revision !== draftRevision.current) return
      if (!ok) {
        setText(submittedText)
        setRoomPlatform(submittedPlatform)
        setDirectDraft(submittedDraft)
        if (hasDirectOptions(parsedDirect.options)) setDirectOpen(true)
        return
      }
      // Ready for the other side, if it is still empty.
      const other = SOURCE_ROLES.find((next) => next !== side && session.snapshot.media[next].status === 'empty' && !loader.state[next].busy)
      if (other) setRole(other)
    }).finally(() => setPendingSubmissions(count => count - 1))
  }

  const load = role ? loader.state[role] : null
  const previous = loader.previousSources ?? {}
  const restorable = SOURCE_ROLES.filter(side => previous[side] && !loader.state[side].busy && ['empty', 'error'].includes(media[side].status))
  const restoreHint = SOURCE_ROLES.filter(side => previous[side]).map(side => `${ROLE_LABEL[side]}：${previous[side]!.label || previous[side]!.input}`).join('；')

  return (
    <div className="intake" role="dialog" aria-modal="true" aria-label="添加直播间">
      <div className="intake-body">
        <div className="intake-heading">
          <h1 className="intake-title">添加直播间</h1>
          <button type="button" className="btn-glass small intake-restore" disabled={loader.restoring || restorable.length === 0}
            title={restoreHint || '暂无可恢复的直播间'} onClick={() => {
              void loader.restorePrevious().then(setRestoreSucceeded)
            }}><Icon name="history" />{loader.restoring ? '恢复中…' : '恢复上次'}</button>
        </div>
        {loader.restoreProblem && <p className="intake-error" role="alert">{loader.restoreProblem}</p>}
        <div className="intake-slots" role="radiogroup" aria-label="添加到">
          {SOURCE_ROLES.map((side) => <Slot key={side} role={side} selected={side === role} onPick={() => pick(side)} />)}
        </div>

        <form className="intake-field" data-disabled={role === null} onSubmit={(event) => { event.preventDefault(); submit() }}>
          <input ref={field} value={text} disabled={role === null}
            onChange={(event) => { draftRevision.current++; setText(event.target.value); setDirectProblem(null); if (role) loader.clearProblem(role) }}
            aria-label="直播间链接" spellCheck={false} autoComplete="off"
            placeholder={role === null ? '先选择画面或解说' : SOURCE_HINT} />
          {role && load?.busy
            ? <button key="cancel" type="button" className="btn-quiet small" onClick={() => loader.cancelLoad(role)}>
              {media[role].descriptor ? '停止此片源' : '取消载入'}
            </button>
            : <button key="submit" type="submit" className="intake-go" disabled={!canSubmit} aria-label="添加" title="添加（回车）">
              <Icon name="enter" />
            </button>}
        </form>

        {role !== null && bare === null && (
          <DirectStreamFields
            input={text}
            draft={directDraft}
            open={directOpen}
            disabled={Boolean(load?.busy)}
            onToggle={() => setDirectOpen(open => !open)}
            onChange={next => { draftRevision.current++; setDirectDraft(next); setDirectProblem(null) }}
          />
        )}

        {bare !== null && role !== null && (
          <div className="intake-ask" role="radiogroup" aria-label="选择房间号所属平台">
            <span className="intake-ask-q">房间 {bare} 属于</span>
            {ROOM_PLATFORMS.map((platform) => (
              <button key={platform} type="button" role="radio" aria-checked={roomPlatform === platform}
                className={roomPlatform === platform ? 'btn-solid small' : 'btn-glass small'}
                onClick={() => { if (platform !== roomPlatform) draftRevision.current++; setRoomPlatform(platform); field.current?.focus() }}>{PLATFORM_LABEL[platform]}</button>
            ))}
          </div>
        )}

        {directProblem && <p className="intake-error" role="alert">{directProblem}</p>}
        {role !== null && <SourceIssue role={role} className="intake-error" />}

        <div className="intake-actions">
          {media.official.status === 'empty' && !loader.state.official.busy && (
            <button type="button" className="intake-find" onClick={onSchedule}>
              <Icon name="trophy" />
              <span>CS2 赛程</span>
              <small>支持一键选择直播间</small>
            </button>
          )}
          {onFavorites && <button type="button" className="intake-find intake-find-single" onClick={onFavorites}><Icon name="star" /><span>收藏夹</span></button>}
        </div>

        <p className="intake-foot">
          <button type="button" className="link-btn intake-skip" onClick={onClose}>{anyLoaded ? '开始观看' : '跳过'}</button>
        </p>
      </div>
    </div>
  )
}

function Slot({ role, selected, onPick }: { role: SourceRole; selected: boolean; onPick: () => void }): React.ReactNode {
  const snapshot = useSessionSnapshot()
  const loader = useSourceLoader()
  const state = snapshot.media[role]
  const load = loader.state[role]
  const status = load.busy ? 'loading' : state.status
  const descriptor = state.descriptor
  return (
    <div className="slot" data-role={role} data-status={status} data-selected={selected}>
      <button type="button" className="slot-pick" role="radio" aria-checked={selected} onClick={onPick}>
        <span className="slot-role">{ROLE_LABEL[role]}</span>
        <span className="slot-what">
          {load.loggingIn ? '等待登录'
            : status === 'loading' ? '载入中…'
              : descriptor ? sourceTitle(descriptor)
                : SOURCE_KINDS}
        </span>
      </button>
      {/* The side being filled shows its problem under the field instead. */}
      {!selected && <SourceIssue role={role} className="slot-error" />}
      {!load.problem && !(state.status === 'error' && state.error) && <LoginOffer role={role} />}
    </div>
  )
}
