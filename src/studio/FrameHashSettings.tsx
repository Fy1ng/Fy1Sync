import { useSession, useSessionSnapshot } from '../app/SessionContext'
import type { RoiRect } from '../core/profileSchema'
import { SOURCE_ROLES } from '../core/types'

const FULL: RoiRect = { x: 0, y: 0, w: 1, h: 1 }
function Region({ label, value, onChange }: { label: string; value: RoiRect; onChange(value: RoiRect): void }): React.ReactNode {
  return <fieldset className="field-stack"><legend>{label}</legend>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
      {([['x', '左侧'], ['y', '顶部'], ['w', '宽度'], ['h', '高度']] as const).map(([key, title]) =>
        <label className="field-stack" key={key}><span className="muted">{title} %</span>
          <input type="number" aria-label={`${label}${title}百分比`} min={key === 'w' || key === 'h' ? 1 : 0} max={100}
            value={Math.round(value[key] * 100)} onChange={event => {
              const number = Number(event.target.value)
              if (!Number.isFinite(number)) return
              const next = { ...value, [key]: Math.max(key === 'w' || key === 'h' ? 0.01 : 0,
                Math.min(key === 'w' || key === 'h' ? 1 : 0.99, number / 100)) }
              next.w = Math.min(next.w, 1 - next.x)
              next.h = Math.min(next.h, 1 - next.y)
              onChange(next)
            }} />
        </label>)}
    </div>
  </fieldset>
}

export function FrameHashSettings(): React.ReactNode {
  const session = useSession()
  const { settings } = useSessionSnapshot()
  return <section className="group" aria-label="画面匹配设置"><h3>画面匹配</h3>
    <p>比较两路相同视角的连续画面, 无需识别倒计时. 在对齐选项中选择画面匹配模式后, 保持两路播放以积累共同片段.</p>
    <p className="muted">分别设置两路对应的比赛主体区域. 下方忽略区域相对于裁剪后的画面, 用于排除广告、摄像头或其他变化的贴片. 修改区域会清空已有匹配记录.</p>
    {SOURCE_ROLES.map(role => <Region key={role} label={role === 'official' ? '官方画面区域' : '解说画面区域'}
      value={settings.frameHashRegions[role]} onChange={value => session.updateSettings({
        frameHashRegions: { ...settings.frameHashRegions, [role]: value },
      })} />)}
    {settings.frameHashMasks.map((value, index) => <div key={index}>
      <Region label={`忽略区域 ${index + 1}`} value={value} onChange={next => session.updateSettings({
        frameHashMasks: settings.frameHashMasks.map((r, i) => i === index ? next : r),
      })} />
      <button type="button" className="btn-quiet" onClick={() => session.updateSettings({
        frameHashMasks: settings.frameHashMasks.filter((_, i) => i !== index),
      })}>移除忽略区域 {index + 1}</button>
    </div>)}
    <div className="row-split">
      <button type="button" className="btn-quiet" disabled={settings.frameHashMasks.length >= 8}
        onClick={() => session.updateSettings({ frameHashMasks: [...settings.frameHashMasks, { x: 0, y: 0, w: 1, h: 0.12 }] })}>添加忽略区域</button>
      <button type="button" className="btn-quiet" onClick={() => session.updateSettings({
        frameHashRegions: { official: { ...FULL }, commentary: { ...FULL } }, frameHashMasks: [],
      })}>恢复完整画面</button>
    </div>
  </section>
}
