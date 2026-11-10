/** Stable recognition evidence and shared source-relative countdown regions. */
import { useEffect, useRef, useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { isBasicClock } from '../core/activeProfile'
import type { RoiRect } from '../core/profileSchema'
import { SOURCE_ROLES, type SourceRole } from '../core/types'
import type { BasicClockProgress, BasicClockVisualFrame, WorkerDebug } from '../recognition/protocol'
import { BasicRegionSheet } from './BasicRegionSheet'
import { Icon } from './kit'
import './BasicRecognitionPanel.css'

const LABEL: Record<SourceRole, string> = { official: '官方画面', commentary: '国内解说' }
const STATUS = { searching: '正在寻找倒计时', confirming: '已找到候选, 正在确认跳秒', locked: '已确认倒计时', ambiguous: '存在多个候选, 尚未确定' } as const
const DROP_TEXT: Record<string, string> = {
  'not-decrement': '读数未按秒递减', 'abnormal-interval': '跳秒间隔异常', 'low-confidence': '匹配分数不足', unparsable: '读数格式无效',
}
const EMPTY_REGIONS: RoiRect[] = []

export function BasicRecognitionPanel(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const [expanded, setExpanded] = useState(true)
  const [framing, setFraming] = useState(false)
  const basic = snapshot.settings.recognitionMode === 'basic'
  useEffect(() => {
    session.setBasicPreviewEnabled(basic && expanded)
    return () => session.setBasicPreviewEnabled(false)
  }, [session, basic, expanded])
  useEffect(() => { if (!basic) setFraming(false) }, [basic])
  if (!basic) return null
  const official = session.engine.element('official')
  const officialReady = isReady(snapshot.media.official.status, official)
  const active = snapshot.profiles.official
  const officialProfile = active && isBasicClock(active) ? active : null
  const sharedRoi = snapshot.settings.basicClockRoi
  const searchRoi = officialProfile?.searchRoi ?? null

  return <section className="basic-recognition" aria-label="基础识别">
    <button type="button" className="basic-recognition__heading" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span>基础识别</span><Icon name="chevron" />
    </button>
    {expanded && <div className="basic-recognition__body">
      <div className="basic-recognition__shared">
        <p>两路共用比例范围, 只需在官方画面框选一次.</p>
        <div className="basic-recognition__actions">
          <button type="button" className="btn-quiet small" onClick={() => setFraming(true)} disabled={!officialReady}>框选倒计时</button>
          <button type="button" className="btn-quiet small" onClick={() => session.setBasicClockRoi(null)}>自动重新寻找</button>
        </div>
        <p className="basic-recognition__manual-note">{sharedRoi ? '手动倒计时框优先, 两路仅识别此框.'
          : searchRoi ? '自动寻找区间由内置生产配置固定, 蓝框表示寻找区间.' : '内置生产配置未限制寻找区间, 当前在全画面寻找.'}</p>
        {!officialReady && <p className="basic-recognition__manual-note">官方画面就绪后可设置两路共用范围.</p>}
      </div>
      {SOURCE_ROLES.map(role => {
        const progress = snapshot.basicProgress[role]
        const current = snapshot.profiles[role]
        const profile = current && isBasicClock(current) ? current : null
        const manual = !!sharedRoi || !!profile?.roi && profile.roiOrigin !== 'memory'
        const memory = !manual && !!profile?.roi && profile.roiOrigin === 'memory'
        const video = session.engine.element(role)
        // A source or region change must not reuse an image from the previous configuration.
        const roleSearchRoi = profile?.searchRoi ?? null
        const visualKey = JSON.stringify([role, snapshot.media[role].descriptor?.url, video.videoWidth, video.videoHeight, profile?.roi, profile?.roiOrigin, roleSearchRoi])
        return <RecognitionCard key={visualKey} role={role} progress={progress} manual={manual} memory={memory}
          ready={isReady(snapshot.media[role].status, video)} searchRoi={roleSearchRoi}
          sampling={snapshot.autoSync.phase === 'sampling' || snapshot.autoSync.phase === 'verifying'} />
      })}
    </div>}
    {framing && <BasicRegionSheet video={official} sourceToken={snapshot.media.official.descriptor}
      initial={sharedRoi ?? officialProfile?.roi ?? snapshot.basicProgress.official?.diagnostic.roi ?? null}
      title="倒计时范围 (两路共用)" saveLabel="使用此范围"
      instructions="在官方当前帧框住倒计时, 确认后两路使用相同比例范围. 手动框优先, 不自动移动或重选."
      onSave={roi => session.setBasicClockRoi(roi)} onClose={() => setFraming(false)} />}
  </section>
}

function isReady(status: string, video: HTMLVideoElement): boolean {
  return status === 'ready' && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0
}

function validImage(image: GrayImage | undefined): image is GrayImage {
  return !!image && Number.isInteger(image.width) && Number.isInteger(image.height) && image.width > 0 && image.height > 0
    && image.width * image.height <= 4_194_304 && image.data.length >= image.width * image.height
}

function RecognitionCard({ role, progress, manual, memory, ready, searchRoi, sampling }: {
  role: SourceRole
  progress: BasicClockProgress | null
  manual: boolean
  memory: boolean
  ready: boolean
  searchRoi: RoiRect | null
  sampling: boolean
}): React.ReactNode {
  const previewFrame = useRef<BasicClockVisualFrame | null>(null)
  const binaryFrame = useRef<BasicClockVisualFrame | null>(null)
  // Images advance only with complete visual snapshots. Status-only updates cannot erase them.
  if (!progress) { previewFrame.current = null; binaryFrame.current = null }
  else if (progress.visual) {
    if (validImage(progress.visual.diagnostic.preview)) previewFrame.current = progress.visual
    if (validImage(progress.visual.debug?.binary)) binaryFrame.current = progress.visual
  }
  const preview = previewFrame.current
  const binary = binaryFrame.current
  const diagnostic = progress?.diagnostic
  const status = !ready ? '等待片源画面' : !diagnostic ? memory ? '已载入记忆范围, 等待开始识别' : '等待开始对齐'
    : manual && diagnostic.status === 'searching' ? '手动范围未读出倒计时, 请检查选框'
    : memory && diagnostic.status === 'searching' ? '记忆范围未读出倒计时, 可重新框选或自动重新寻找' : STATUS[diagnostic.status]
  const matches = binary?.debug?.matches ?? []
  const fixed = manual || memory
  return <article className="basic-recognition__card" aria-label={`${LABEL[role]}基础识别`} data-role={role} data-state={diagnostic?.status ?? 'idle'}>
    <div className="basic-recognition__card-head">
      <strong>{LABEL[role]}</strong><span className="basic-recognition__mode">{manual ? '手动范围' : memory ? '记忆范围' : '自动范围'}</span>
    </div>
    <p className="basic-recognition__status" role="status">{progress?.error || status}</p>
    {progress?.sync && <p className="basic-recognition__counts">有效读数 {progress.sync.readings}, 跳秒 {progress.sync.jumps}
      {progress.sync.lastDrop ? `, ${DROP_TEXT[progress.sync.lastDrop] ?? progress.sync.lastDrop}` : ''}</p>}
    <div className={`basic-recognition__visuals${fixed ? ' is-fixed' : ''}`}>
      {!fixed && <figure>
        <figcaption>寻找预览{preview ? ` ${frameTime(preview)}` : ''}</figcaption>
        {preview ? <DiagnosticCanvas image={preview.diagnostic.preview!} regions={preview.diagnostic.candidates ?? EMPTY_REGIONS}
          selected={preview.diagnostic.roi} searchRegion={searchRoi ?? undefined} label={`${LABEL[role]}寻找预览`} />
          : <p className="basic-recognition__placeholder">{sampling && ready ? '等待寻找画面...' : '开始对齐后显示实际寻找画面'}</p>}
      </figure>}
      <figure>
        <figcaption>二值结果{binary ? ` ${frameTime(binary)}` : ''}</figcaption>
        {binary ? <DiagnosticCanvas image={binary.debug!.binary} boxes={binary.debug!.boxes} label={`${LABEL[role]}二值化结果`} />
          : <p className="basic-recognition__placeholder">等待此范围的二值结果</p>}
      </figure>
    </div>
    {binary && <>
      <p className="basic-recognition__reading">
        {binary.diagnostic.status === 'locked' ? '图中读数 ' : '图中候选读数 '}
        <output aria-label={`${LABEL[role]}识别读数`}>{binary.diagnostic.text || '未读出'}</output>
        {binary.diagnostic.status !== 'locked' && <span>待确认</span>}
      </p>
      <p className="basic-recognition__stamp">{sampling ? '二值帧' : '上次采样'} {frameTime(binary)}
        {binary.diagnostic.threshold !== undefined ? `, 阈值 ${binary.diagnostic.threshold}` : ''}</p>
    </>}
    {matches.length > 0 && <details className="basic-recognition__matches">
      <summary>图中字符匹配详情</summary>
      <div>{matches.map((match, index) => <span key={index}
        className={match.score < .82 || match.score - match.runnerUpScore < .035 ? 'is-weak' : undefined}>
        {match.char ?? '?'} {Math.round(match.score * 100)}% / {Math.round(match.runnerUpScore * 100)}%
      </span>)}</div><p>最佳 / 次佳匹配分数</p>
    </details>}
    {memory && <p className="basic-recognition__manual-note">直接识别记忆范围, 重新框选或自动重新寻找后更改.</p>}
  </article>
}

function frameTime(frame: BasicClockVisualFrame): string {
  return Number.isFinite(frame.diagnostic.mediaTime) ? `${frame.diagnostic.mediaTime!.toFixed(2)}s` : '时间未知'
}

interface GrayImage { width: number; height: number; data: Uint8Array }

function DiagnosticCanvas({ image, boxes, regions, selected, searchRegion, label }: {
  image: GrayImage
  boxes?: WorkerDebug['boxes']
  regions?: RoiRect[]
  selected?: RoiRect
  searchRegion?: RoiRect
  label: string
}): React.ReactNode {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const node = canvas.current
    if (!node || !validImage(image)) return
    if (node.width !== image.width) node.width = image.width
    if (node.height !== image.height) node.height = image.height
    const context = node.getContext('2d')
    if (!context) return
    const pixels = context.createImageData(image.width, image.height)
    for (let index = 0; index < image.width * image.height; index++) {
      const value = image.data[index]!, offset = index * 4
      pixels.data[offset] = value; pixels.data[offset + 1] = value; pixels.data[offset + 2] = value; pixels.data[offset + 3] = 255
    }
    context.putImageData(pixels, 0, 0)
    context.lineWidth = Math.max(1, image.width / 500)
    if (searchRegion) {
      context.strokeStyle = '#91c5ff'
      context.strokeRect(searchRegion.x * image.width, searchRegion.y * image.height, searchRegion.w * image.width, searchRegion.h * image.height)
    }
    context.strokeStyle = '#e9bb6a'
    for (const box of boxes ?? []) context.strokeRect(box.x, box.y, box.width, box.height)
    for (const roi of regions ?? []) context.strokeRect(roi.x * image.width, roi.y * image.height, roi.w * image.width, roi.h * image.height)
    if (selected) {
      context.strokeStyle = '#79d2b2'
      context.strokeRect(selected.x * image.width, selected.y * image.height, selected.w * image.width, selected.h * image.height)
    }
  }, [image, boxes, regions, selected, searchRegion])
  return <canvas ref={canvas} className={`basic-recognition__canvas${boxes ? ' is-binary' : ''}`} aria-label={label} />
}
