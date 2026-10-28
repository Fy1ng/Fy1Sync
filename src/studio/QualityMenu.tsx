/**
 * 清晰度, in the dock's right corner where players keep it: one button per side, each showing
 * that side's current level, so either can be changed without swapping pictures.
 *
 * Two kinds of choice end up here. A resolver quality (`sourceQualities`) restarts the
 * acquisition, so it is busy until the new stream plays; an HLS level only tells hls.js
 * which rendition to fetch next.
 */

import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { SOURCE_ROLES, type SourceRole } from '../core/types'
import { Popover, usePopover } from './kit'
import { ROLE_LABEL } from './sources'

interface Choice { key: string; label: string; on: boolean; pick: () => void }
interface Side { role: SourceRole; busy: boolean; choices: Choice[]; current: string }

function useSides(): Side[] {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const order: SourceRole[] = [snapshot.mainRole, ...SOURCE_ROLES.filter((role) => role !== snapshot.mainRole)]
  return order.flatMap((role): Side[] => {
    const state = snapshot.media[role]
    if (state.status === 'empty') return []
    const sourced = state.descriptor?.sourceQualities ?? []
    if (sourced.length > 0) {
      const selected = state.descriptor?.sourceQuality ?? ''
      return [{
        role,
        busy: snapshot.qualityBusy[role],
        current: sourced.find((option) => option.id === selected)?.label ?? '清晰度',
        choices: sourced.map((option) => ({
          key: option.id, label: option.label, on: option.id === selected,
          pick: () => void session.changeSourceQuality(role, option.id),
        })),
      }]
    }
    if (state.quality.length > 1) {
      return [{
        role,
        busy: false,
        current: state.quality.find((option) => option.level === state.level)?.label ?? '自动',
        choices: state.quality.map((option) => ({
          key: String(option.level), label: option.label, on: option.level === state.level,
          pick: () => session.engine.setLevel(role, option.level),
        })),
      }]
    }
    return []
  })
}

/** One button per loaded side, main picture first, each opening only its own levels. */
export function QualityMenu(): React.ReactNode {
  const { mainRole } = useSessionSnapshot()
  const sides = useSides()
  if (sides.length === 0) return null
  return (
    <div className="quality-pair">
      {sides.map((side) => <SideQuality key={side.role} side={side} main={side.role === mainRole} />)}
    </div>
  )
}

function SideQuality({ side, main }: { side: Side; main: boolean }): React.ReactNode {
  const menu = usePopover()
  const label = `${ROLE_LABEL[side.role]}清晰度`
  return (
    <div className="quality-control" data-role={side.role}>
      <button type="button" className="quality-btn" data-main={main || undefined} {...menu.trigger}
        aria-label={label} title={`${label}${main ? '（主画面）' : ''}`}>
        <span className="quality-side-name">{ROLE_LABEL[side.role]}</span>
        <span className="num">{side.busy ? '切换中' : side.current}</span>
      </button>
      <Popover {...menu.popover} className="quality-menu" label={label}>
        <p className="menu-heading">{label}</p>
        {side.choices.map((choice) => (
          <button type="button" key={choice.key} role="menuitemradio" aria-checked={choice.on}
            className={`menu-item quality-item${choice.on ? ' is-on' : ''}`} disabled={side.busy}
            onClick={() => { choice.pick(); menu.close() }}>
            {choice.label}
          </button>
        ))}
      </Popover>
    </div>
  )
}
