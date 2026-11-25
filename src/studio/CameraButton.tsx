/**
 * The streamer camera window, from the dock's right corner: frame it on the commentary
 * picture, then show, hide or size the window it floats in. Only there while the commentary plays.
 */

import type { CameraControls } from '../app/useCamera'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { clampWindow } from '../ui/CameraOverlay'
import type { CameraUpscaleState } from '../ui/useCameraUpscale'
import { Icon, Popover, Range, Segmented, Switch, usePopover } from './kit'

export function CameraButton({
  camera,
  onFrame,
  upscale,
  stageRef,
}: {
  camera: CameraControls
  onFrame: () => void
  upscale?: CameraUpscaleState
  stageRef?: React.RefObject<HTMLElement | null>
}): React.ReactNode {
  const menu = usePopover()
  const session = useSession()
  const { settings } = useSessionSnapshot()
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

  const resizeFromMenu = (percent: number): void => {
    const stageNode = stageRef?.current
    const stage = { width: stageNode?.clientWidth ?? 0, height: stageNode?.clientHeight ?? 0 }
    const video = session.engine.element('commentary')
    const videoAspect = video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9
    const cropAspect = config.crop.h > 0 ? config.crop.w / config.crop.h : 16 / 9
    camera.setWindow(clampWindow({ ...config.window, width: percent / 100 }, stage, cropAspect * videoAspect))
  }

  return (
    <div className="camera-control">
      <button type="button" className={`icon-btn ${config.enabled ? 'is-on' : ''}`.trim()} {...menu.trigger}
        aria-label="主播摄像头" title="主播摄像头">
        <Icon name="user" />
      </button>
      <Popover {...menu.popover} className="camera-menu" label="主播摄像头">
        <button type="button" className="menu-item" onClick={() => { menu.close(); camera.setEnabled(!config.enabled) }}>
          {config.enabled ? '隐藏摄像头小窗' : '显示摄像头小窗'}
        </button>
        <button type="button" className="menu-item" onClick={() => { menu.close(); onFrame() }}>重新框选</button>
        <div className="camera-options">
          <Range label="小窗大小" value={Math.round(config.window.width * 100)} min={8} max={60} step={1} unit="%"
            onChange={resizeFromMenu} />
          <Switch label="弹幕浮于小窗上方" checked={settings.danmaku.danmakuOverCamera}
            onChange={danmakuOverCamera => session.updateDanmakuSettings({ danmakuOverCamera })} />
        </div>
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
