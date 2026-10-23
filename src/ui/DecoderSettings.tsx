import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import type { DecoderMode, DecoderPreferenceState } from '../../electron/decoderPreferences'
import { Toggle } from './controls/Toggle'

const modeName = (mode: DecoderMode) => mode === 'software' ? '软件解码兼容模式' : '自动解码 (硬件优先)'

export function DecoderSettings(): React.ReactNode {
  const [state, setState] = useState<DecoderPreferenceState | null>(null)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const saving = useRef(false)

  useEffect(() => {
    mounted.current = true
    let current = true
    void apiClient.getDecoderPreferences().then(result => {
      if (!current) return
      if (result.ok) setState(result.value)
      else setError(result.message)
      setPending(false)
    })
    return () => { current = false; mounted.current = false }
  }, [])

  const save = async (enabled: boolean) => {
    if (saving.current || pending || !state) return
    saving.current = true
    setPending(true)
    setError('')
    try {
      const result = await apiClient.setDecoderPreferences(enabled ? 'software' : 'auto')
      if (!mounted.current) return
      if (result.ok) setState(result.value)
      else setError(result.message)
    } finally {
      saving.current = false
      if (mounted.current) setPending(false)
    }
  }

  return <section className="account-section" aria-label="视频解码">
    <h3>视频解码</h3>
    <Toggle label="软件解码兼容模式" checked={state?.mode === 'software'} disabled={pending || !state}
      onChange={enabled => void save(enabled)} />
    <p className="hint">用于尝试改善硬件解码兼容性, 可能增加 CPU 占用. 保存后请手动关闭应用并重新打开, 当前播放会继续.</p>
    {state && <p className="hint" role="status">
      当前生效: {modeName(state.effectiveMode)}.
      {state.restartRequired ? ` 已保存, 待重启: ${modeName(state.mode)}.` : ' 已保存的选择与当前模式一致.'}
    </p>}
    {state?.forcedByCommandLine && <p className="hint">启动参数已强制软件解码. 要恢复自动解码, 还需移除对应启动参数后重开应用.</p>}
    {pending && <p className="hint" role="status">{state ? '正在保存解码设置...' : '正在读取解码设置...'}</p>}
    {error && <p className="dialog-error" role="alert">{error}</p>}
  </section>
}
