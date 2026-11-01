export interface AutoStepControlProps {
  running: boolean
  canStart: boolean
  steps: number
  onStart: () => void
  onStop: () => void
}

export function AutoStepControl({ running, canStart, steps, onStart, onStop }: AutoStepControlProps): React.ReactNode {
  return (
    <span className="editor-transport-group" role="group" aria-label="自动逐秒标注">
      <button type="button" className={`${running ? 'btn-solid' : 'btn-quiet'} small num`}
        disabled={!running && !canStart} onClick={running ? onStop : onStart}
        title="每次前进 1s, 完成当前帧处理后再继续. 按起始倒计时推算标注, 字符框数不符时停止, 不以识别置信度决定停止; 已完成结果可撤回.">
        {running ? '停止自动 +1s' : '自动 +1s'}
      </button>
      {(running || steps > 0) && <small className="muted num">已处理 {steps} 帧</small>}
    </span>
  )
}
