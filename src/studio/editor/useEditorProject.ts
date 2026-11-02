/** The current editing session lives outside the portable style pack. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HudStylePack } from '../../core/hudStylePack'
import type { EditorMedia, EditorProject } from '../../../electron/editorProjectContracts'

export function useEditorProject(options: {
  pack: HudStylePack; variantId: string
  restorePack: (pack: HudStylePack, variantId: string) => void
  open: (url: string, name: string) => void
}) {
  const [ready, setReady] = useState(!window.streamSyncer)
  const [loaded, setLoaded] = useState(false)
  const [media, setMedia] = useState<EditorMedia[]>([])
  const [currentMediaId, setCurrentMediaId] = useState<string | null>(null)
  const [needsRelink, setNeedsRelink] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const callbacks = useRef(options)
  callbacks.current = options
  const current = media.find(item => item.id === currentMediaId) ?? null

  useEffect(() => {
    const bridge = window.streamSyncer
    if (!bridge) return
    let active = true
    void bridge.invoke('editorProjectLoad', undefined).then(async result => {
      if (!active) return
      if (!result.ok) {
        if (result.code !== 'unknown-method') setError(result.message)
        return
      }
      const saved = result.value
      setLoaded(true)
      if (!saved.project) return
      const project = saved.project
      callbacks.current.restorePack(project.pack, project.variantId)
      setMedia(project.media)
      setCurrentMediaId(project.currentMediaId)
      setNeedsRelink(saved.needsRelink)
      const item = project.media.find(entry => entry.id === project.currentMediaId)
      if (saved.media && item) callbacks.current.open(saved.media.url, item.name)
      else if (item?.kind === 'youtube') {
        const restored = await bridge.invoke('ytImportList', undefined)
        if (!active) return
        const clip = restored.ok ? restored.value.find(job => job.assetId === item.assetId && job.state === 'ready') : null
        if (clip?.mediaUrl) callbacks.current.open(clip.mediaUrl, item.name)
        else setError('下载素材不可用, 请重新下载或选择其他素材.')
      }
    }).catch(() => { if (active) setError('编辑器工程读取失败, 请重试.') })
      .finally(() => { if (active) setReady(true) })
    return () => { active = false }
  }, [])

  // One save in flight; edits made meanwhile collapse into the newest snapshot, sent when it lands.
  const queued = useRef<EditorProject | null>(null)
  const inFlight = useRef(false)
  const send = useCallback((): void => {
    const bridge = window.streamSyncer
    const project = queued.current
    if (!bridge || !project || inFlight.current) return
    queued.current = null
    inFlight.current = true
    void bridge.invoke('editorProjectSave', { project }).then(result => setSaveError(result.ok ? null : result.message))
      .catch(() => setSaveError('编辑器工程自动保存失败, 请重试.'))
      .finally(() => { inFlight.current = false; send() })
  }, [])
  useEffect(() => {
    if (!ready || !loaded || !window.streamSyncer) return
    queued.current = { version: 1, pack: options.pack, variantId: options.variantId, media, currentMediaId }
    send()
  }, [ready, loaded, options.pack, options.variantId, media, currentMediaId, send])

  const remember = useCallback((item: EditorMedia): void => {
    setMedia(items => {
      const previous = items.find(entry => entry.id === item.id)
      return [...items.filter(entry => entry.id !== item.id), previous ? { ...item, match: previous.match, purpose: previous.purpose } : item]
    })
    setCurrentMediaId(item.id)
    setNeedsRelink(false)
    setError(null)
  }, [])
  const choose = async (relink = false): Promise<void> => {
    if (!window.streamSyncer) return
    try {
      const result = await window.streamSyncer.invoke('editorMediaChoose', relink && current ? { relinkId: current.id } : {})
      if (!result.ok) { setError(result.message); return }
      if (!result.value) return
      remember(result.value.media)
      callbacks.current.open(result.value.url, result.value.media.name)
    } catch { setError('本地录像打开失败, 请重试.') }
  }
  const annotate = useCallback((update: Partial<Pick<EditorMedia, 'match' | 'purpose'>>): void => {
    setMedia(items => items.map(item => item.id === currentMediaId ? { ...item, ...update } : item))
  }, [currentMediaId])
  const clear = useCallback(() => { setCurrentMediaId(null); setNeedsRelink(false) }, [])
  return { ready, current, needsRelink, error: error ?? saveError, choose, remember, annotate, clear }
}
