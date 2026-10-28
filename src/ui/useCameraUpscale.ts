import { useEffect, useRef, useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import type { CameraConfig } from '../app/camera'
import type { CameraUpscaleTier } from '../app/settings'
import { CameraUpscaler, probeWebGpu } from '../media/upscale/renderer'

export interface CameraUpscaleState {
  supported: boolean
  mode: '2d' | 'webgpu'
  tier: CameraUpscaleTier
  reason: string
}

export const INITIAL_UPSCALE_STATE: CameraUpscaleState = { supported: false, mode: '2d', tier: 'off', reason: 'initializing' }

/** The cap belongs to the watching session, including overlay hide/show and room changes. */
const limits = new WeakMap<object, { choice: CameraUpscaleTier; cap: CameraUpscaleTier; retries: number }>()

export function useCameraUpscale(config: CameraConfig, cssWidth: number, cssHeight: number) {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const choice = snapshot.settings.cameraUpscale
  const source = snapshot.media.commentary.descriptor
  const video = session.engine.element('commentary')
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const renderer = useRef<CameraUpscaler | null>(null)
  const [supported, setSupported] = useState(false)
  const [checked, setChecked] = useState(false)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<CameraUpscaleState>(INITIAL_UPSCALE_STATE)
  let limit = limits.get(session)
  if (!limit || limit.choice !== choice) {
    limit = { choice, cap: choice, retries: limit?.retries ?? 0 }
    limits.set(session, limit)
  }
  const tier = limit.cap
  const active = supported && !failed && config.enabled && !snapshot.pipPresentationReduced && tier !== 'off'
  const current = useRef({ config, cssWidth, cssHeight, tier })
  current.current = { config, cssWidth, cssHeight, tier }

  const options = () => {
    const value = current.current
    return {
      crop: {
        x: value.config.crop.x * video.videoWidth,
        y: value.config.crop.y * video.videoHeight,
        width: Math.max(1, value.config.crop.w * video.videoWidth),
        height: Math.max(1, value.config.crop.h * video.videoHeight),
      },
      cssWidth: canvas.current?.clientWidth || value.cssWidth,
      cssHeight: canvas.current?.clientHeight || value.cssHeight,
      dpr: window.devicePixelRatio || 1,
      tier: value.tier === 'quality' ? 'quality' as const : 'performance' as const,
    }
  }
  const getOptions = useRef(options)
  getOptions.current = options

  useEffect(() => {
    let cancelled = false
    void probeWebGpu().then(value => { if (!cancelled) { setSupported(value); setChecked(true) } })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!active || !canvas.current || !source) return
    setState({ supported: true, mode: '2d', tier: 'off', reason: 'initializing' })
    let cancelled = false
    let owned: CameraUpscaler | null = null
    void CameraUpscaler.create({
      canvas: canvas.current,
      video,
      options: getOptions.current(),
      onState: (diagnostics) => {
        if (cancelled) return
        setState(previous => {
          const next: CameraUpscaleState = {
            supported: true, mode: 'webgpu', tier: diagnostics.tier,
            reason: limits.get(session)?.cap !== choice ? 'overload' : 'active',
          }
          return previous.mode === next.mode && previous.tier === next.tier && previous.reason === next.reason ? previous : next
        })
      },
      onDowngrade: (next) => {
        if (cancelled) return
        limits.get(session)!.cap = next
        session.notice('warn', next === 'off' ? '摄像头超分负载过高, 已关闭' : '摄像头超分负载过高, 已降为省电')
        setRevision(value => value + 1)
      },
      onFailure: (reason) => {
        if (cancelled) return
        const entry = limits.get(session)!
        setState({ supported: true, mode: '2d', tier: 'off', reason })
        if (reason === 'device-lost' && entry.retries++ === 0) setRevision(value => value + 1)
        else setFailed(true)
      },
    }).then(instance => {
      if (cancelled) instance.dispose()
      else {
        owned = instance
        renderer.current = instance
        instance.update(getOptions.current())
      }
    }).catch(() => {
      if (!cancelled) { setSupported(false); setFailed(true) }
    })
    return () => {
      cancelled = true
      owned?.dispose()
      renderer.current = null
    }
  }, [active, source, video, session, choice, revision])

  useEffect(() => {
    const update = () => renderer.current?.update(getOptions.current())
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    if (canvas.current) observer?.observe(canvas.current)
    window.addEventListener('resize', update)
    video.addEventListener('resize', update)
    video.addEventListener('loadedmetadata', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      video.removeEventListener('resize', update)
      video.removeEventListener('loadedmetadata', update)
    }
  }, [config.crop, cssWidth, cssHeight, tier, video, active, revision])

  const reason = !supported ? (checked || failed ? 'unsupported' : 'initializing') : snapshot.pipPresentationReduced ? 'low-power'
    : tier === 'off' ? (choice === 'off' ? 'off' : 'overload') : failed ? state.reason : !config.enabled ? 'hidden' : null
  return {
    canvas,
    canvasKey: revision,
    active,
    state: reason ? { supported, mode: '2d' as const, tier: 'off' as const, reason } : state,
  }
}
