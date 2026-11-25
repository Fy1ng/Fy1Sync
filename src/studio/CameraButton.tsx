/**
 * The streamer camera window, from the dock's right corner: frame it on the commentary
 * picture, then show or hide the window it floats in. Only there while the commentary plays.
 */

import type { CameraControls } from '../app/useCamera'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import type { CameraUpscaleState } from '../ui/useCameraUpscale'
import { Icon, Popover, Segmented, usePopover } from './kit'

export function CameraButton({ camera, onFrame, upscale }: { camera: CameraControls; onFrame: () => void; upscale?: CameraUpscaleState }): React.ReactNode {
  const menu = usePopover()
  const session = useSession()
  const { settings, mainRole } = useSessionSnapshot()
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
      <button type="button" className={`icon-btn ${config.enabled ? 'is-on' : ''}`.trim()} {...menu.trigger}
        aria-label="主播摄像头" title="主播摄像头">
        <Icon name="user" />
      </button>
      <Popover {...menu.popover} className="camera-menu" label="主播摄像头">
        <button type="button" className="menu-item" onClick={() => { menu.close(); camera.setEnabled(!config.enabled) }}>
          {config.enabled ? '隐藏主播摄像头' : '显示主播摄像头'}
        </button>
        <div className="camera-upscale">
          <span>显示方式</span>
          <Segmented value={config.mode ?? 'window'} label="显示方式" options={[
            { value: 'window', label: '悬浮窗' }, { value: 'inplace', label: '画面透传' },
          ]} onChange={mode => camera.setMode(mode)} />
          {config.mode === 'inplace' && <small>{mainRole === 'commentary' ? '解说为主画面时无需透传' : '按框选位置替换主画面对应区域'}</small>}
        </div>
        <button type="button" className="menu-item" onClick={() => { menu.close(); onFrame() }}>重新框选</button>
        {upscale?.supported && <div className="camera-upscale">
          <span>小窗画质增强</span>
          <Segmented value={settings.cameraUpscale} label="小窗画质增强" options={[
            { value: 'off', label: '关' }, { value: 'performance', label: '省电' }, { value: 'quality', label: '画质' },
          ]} onChange={cameraUpscale => session.updateSettings({ cameraUpscale })} />
          {upscale.reason === 'overload' && <small>{upscale.tier === 'off' ? '负载过高，已关闭增强' : '已切到省电'}</small>}
          {upscale.reason === 'low-power' && settings.cameraUpscale !== 'off' && <small>画中画低功耗时暂停增强</small>}
          {(upscale.reason === 'device-lost' || upscale.reason === 'render-error') && <small>已回退原画</small>}
        </div>}
      </Popover>
    </div>
  )
}
