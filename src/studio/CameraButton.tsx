/**
 * The streamer camera window, from the dock's right corner: frame it on the commentary
 * picture, then show or hide the window it floats in. Only there while the commentary plays.
 */

import type { CameraControls } from '../app/useCamera'
import { Icon, Popover, usePopover } from './kit'

export function CameraButton({ camera, onFrame }: { camera: CameraControls; onFrame: () => void }): React.ReactNode {
  const menu = usePopover()
  if (!camera.available) return null
  const config = camera.config
  // Nothing framed yet: one press opens the framing sheet, with no menu in between.
  if (!config) {
    return (
      <button type="button" className="icon-btn" onClick={onFrame} aria-label="框选主播摄像头" title="框选主播摄像头">
        <Icon name="user" />
      </button>
    )
  }
  return (
    <div className="camera-control">
      <button type="button" className={`icon-btn ${config.enabled ? 'is-on' : ''}`.trim()} onClick={menu.toggle}
        aria-label="主播摄像头" aria-expanded={menu.open} title="主播摄像头">
        <Icon name="user" />
      </button>
      <Popover open={menu.open} onClose={menu.close} className="camera-menu" label="主播摄像头">
        <button type="button" className="menu-item" onClick={() => { menu.close(); camera.setEnabled(!config.enabled) }}>
          {config.enabled ? '隐藏摄像头小窗' : '显示摄像头小窗'}
        </button>
        <button type="button" className="menu-item" onClick={() => { menu.close(); onFrame() }}>重新框选</button>
      </Popover>
    </div>
  )
}
