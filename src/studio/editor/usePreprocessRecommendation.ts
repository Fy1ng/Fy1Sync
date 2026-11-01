import { useEffect, useRef, useState, type RefObject } from 'react'
import type { HudStylePack } from '../../core/hudStylePack'
import type { HudPreprocessRequest, HudPreprocessSettings } from '../../core/hudPreprocess'
import { recommendHudPreprocess } from '../../core/hudWasm'
import type { GrabbedFrame } from '../../recognition/frameGrabber'
import type { EditorTarget } from './cueModel'

interface Options {
  frame: GrabbedFrame | null
  pack: HudStylePack
  variantId: string
  target: EditorTarget
  revision: RefObject<number>
  disabled: boolean
  apply: (settings: HudPreprocessSettings) => void
  message: (message: { kind: 'info' | 'warn' | 'error'; text: string }) => void
}

const REASONS: Record<string, string> = {
  'low-contrast': '当前区域颜色或亮度差异不足, 请调整区域或改用 HSV 取色',
  'ambiguous-polarity': '无法可靠判断前景方向, 参数保持不变, 请手动设置反相',
  'invalid-color': '该位置不适合取色, 请点击图标或文字的实心部分',
}

export function usePreprocessRecommendation(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const request = useRef<object | null>(null)
  const mounted = useRef(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current = null }
  }, [])
  useEffect(() => { request.current = null; setBusy(false) }, [options.frame, options.target, options.variantId, options.pack.id])

  const recommend = async (kind: HudPreprocessRequest['kind'], point?: { x: number; y: number }): Promise<void> => {
    const current = latest.current
    if (!current.frame || current.disabled || request.current || (kind === 'hsv' && !point)) return
    const token = {}
    request.current = token
    setBusy(true)
    const revision = current.revision.current
    const stillCurrent = () => mounted.current && request.current === token && current.frame === latest.current.frame
      && current.target === latest.current.target && current.variantId === latest.current.variantId
      && revision === current.revision.current && !latest.current.disabled
    try {
      const result = await recommendHudPreprocess(current.frame, current.pack, current.variantId, current.target,
        kind === 'hsv' ? { kind, x: point!.x, y: point!.y } : { kind })
      if (!stillCurrent()) return
      if (!result.settings) {
        current.message({ kind: 'warn', text: REASONS[result.reason ?? ''] ?? '无法可靠推荐参数, 当前设置保持不变' })
        return
      }
      current.apply(result.settings)
      current.message({ kind: 'info', text: '已应用当前帧的推荐参数并固定, 不会逐帧自动切换. 请检查前景掩码, 已有模板需重新验证.' })
    } catch (error) {
      if (stillCurrent()) current.message({ kind: 'error', text: `参数推荐失败: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      if (request.current === token) { request.current = null; if (mounted.current) setBusy(false) }
    }
  }
  return { busy, recommend }
}
