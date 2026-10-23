import { locateTool, locateYouTubePotProvider, toolOverride, type ToolContext, type ToolName, type ToolSettings } from './toolLocator'
import { toolVersion } from './toolVersions'
import type { ToolUpdaterService, ToolUpdateState } from './toolUpdater'
import { stat } from 'node:fs/promises'
import toolsLock from '../packaging/tools-lock.json'

export interface ToolInfo { name: ToolName; source: 'external' | 'managed' | 'bundled' | 'PATH'; version: string; available: boolean }
export interface ToolsStatus {
  tools: ToolInfo[]
  provider: { available: boolean; source: 'external' | 'bundled' | 'none'; version: string }
  update: ToolUpdateState
  externalYtdlp: boolean
  fixturesAvailable: boolean
  bundledAvailable: boolean
}
export interface ToolsService {
  status(): Promise<ToolsStatus>
  update(): Promise<ToolsStatus>
  restore(target: 'previous' | 'bundled'): Promise<ToolsStatus>
}
export class DesktopTools implements ToolsService {
  private versions = new Map<string, Promise<string>>()
  constructor(private readonly settings: ToolSettings, private readonly context: ToolContext, private readonly updater: ToolUpdaterService,
    private readonly env = process.env, private readonly fixturesAvailable = false) {}
  async status(): Promise<ToolsStatus> {
    const managed = await this.context.managedYtdlp?.()
    const tools = await Promise.all((['ffmpeg', 'ffprobe', 'yt-dlp'] as const).map(async name => {
      const source = toolOverride(name, this.settings, this.env) ? 'external' : name === 'yt-dlp' && managed ? 'managed' : this.context.bundledDir ? 'bundled' : 'PATH'
      try {
        const file = await locateTool(name, this.settings, this.env, this.context)
        const metadata = await stat(file), key = `${file}:${metadata.size}:${metadata.mtimeMs}`
        let version = this.versions.get(key)
        if (!version) {
          if (this.versions.size > 32) this.versions.clear()
          version = toolVersion(file, name === 'yt-dlp').catch(() => '版本读取失败'); this.versions.set(key, version)
        }
        return { name, source, version: await version, available: true } as ToolInfo
      } catch { return { name, source, version: '不可用', available: false } as ToolInfo }
    }))
    const provider = await locateYouTubePotProvider(this.env, this.context)
    const externalProvider = !!(this.env.STREAM_SYNC_POT_PLUGIN_DIR || this.env.STREAM_SYNC_POT_SERVER_HOME)
    const externalYtdlp = toolOverride('yt-dlp', this.settings, this.env)
    const update = this.updater.state()
    if (externalYtdlp && update.phase === 'ready') update.message = '下载版本已校验并保存. 当前外部 yt-dlp 配置仍优先, 原文件未替换.'
    return { tools, provider: { available: !!provider, source: provider ? externalProvider ? 'external' : 'bundled' : 'none', version: provider ? externalProvider ? '外部配置' : toolsLock.providerVersion : '不可用' },
      update, externalYtdlp, fixturesAvailable: this.fixturesAvailable, bundledAvailable: !!this.context.bundledDir }
  }
  async update(): Promise<ToolsStatus> { await this.updater.update(); return this.status() }
  async restore(target: 'previous' | 'bundled'): Promise<ToolsStatus> { await this.updater.restore(target); return this.status() }
}
