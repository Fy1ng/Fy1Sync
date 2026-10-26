import { expect, type RunningApplication } from './electron'
import { invoke, openSettings, setCheckedByLabel } from './helpers'

/** The production UI/IPC is the only writer; restart retains one disposable profile. */
export async function selectSoftwareDecoding(running: RunningApplication, enabled: boolean) {
  const dialog = await openSettings(running.page)
  const checkbox = dialog.getByRole('switch', { name: /^软件解码/ })
  await expect(checkbox).toBeEnabled()
  await setCheckedByLabel(checkbox, enabled)
  await expect(checkbox).toBeEnabled()
  await expect.poll(async () => {
    const state = await invoke(running.page, 'getDecoderPreferences', undefined)
    return state.ok && state.value.mode
  }).toBe(enabled ? 'software' : 'auto')
}

export async function decodingStartup(running: RunningApplication) {
  const preferences = await invoke(running.page, 'getDecoderPreferences', undefined)
  const switches = await running.application.evaluate(({ app }) => ({
    videoDisabled: app.commandLine.hasSwitch('disable-accelerated-video-decode'),
    gpuDisabled: app.commandLine.hasSwitch('disable-gpu'),
    gpuCompositingDisabled: app.commandLine.hasSwitch('disable-gpu-compositing'),
    features: app.getGPUFeatureStatus(),
  }))
  return { preferences, switches }
}
