import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export type ToolName = 'ffmpeg' | 'ffprobe' | 'yt-dlp'
export interface ToolSettings { ffmpegPath?: string; ffprobePath?: string; ytdlpPath?: string }
export interface ToolContext {
  /** Set by main only when app.isPackaged, never inferred from a development directory. */
  bundledDir?: string
  managedYtdlp?: () => Promise<string | undefined>
  providerCacheHome?: string
}
export interface YouTubePotProvider { pluginDir: string; serverHome: string }
export type ToolErrorCode = 'tool-missing' | 'tool-invalid-path' | 'tool-not-executable'
const ENV_KEYS: Record<ToolName, string> = { ffmpeg: 'STREAM_SYNC_FFMPEG', ffprobe: 'STREAM_SYNC_FFPROBE', 'yt-dlp': 'STREAM_SYNC_YTDLP' }
const SETTING_KEYS = { ffmpeg: 'ffmpegPath', ffprobe: 'ffprobePath', 'yt-dlp': 'ytdlpPath' } as const

/** Public errors deliberately omit local paths and inherited environment values. */
export class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, readonly tool: ToolName) {
    super(code === 'tool-missing' ? `未找到 ${tool}, 请在设置或 ${ENV_KEYS[tool]} 中指定工具路径` : `${tool} 工具路径无效或不可执行, 请检查设置和文件权限`)
    this.name = 'ToolError'
  }
  toJSON(): { code: ToolErrorCode; tool: ToolName; message: string } { return { code: this.code, tool: this.tool, message: this.message } }
}

export function toolOverride(tool: ToolName, settings: ToolSettings = {}, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(settings[SETTING_KEYS[tool]] || env[ENV_KEYS[tool]])
}

export async function locateTool(tool: ToolName, settings: ToolSettings = {}, env: NodeJS.ProcessEnv = process.env, context: ToolContext = {}): Promise<string> {
  const configured = settings[SETTING_KEYS[tool]] || env[ENV_KEYS[tool]]
  if (configured) {
    const candidate = configured.trim()
    if (!path.isAbsolute(candidate) || candidate.includes('\0')) throw new ToolError('tool-invalid-path', tool)
    return await executable(candidate, tool)
  }
  if (tool === 'yt-dlp' && context.managedYtdlp) {
    const managed = await context.managedYtdlp()
    if (managed) return await executable(managed, tool)
  }
  if (context.bundledDir) {
    // A broken packaged installation must not silently execute an arbitrary PATH tool.
    return await executable(path.join(context.bundledDir, tool === 'yt-dlp' ? 'yt-dlp.exe' : 'ffmpeg', ...(tool === 'yt-dlp' ? [] : [`${tool}.exe`])), tool)
  }
  const search = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  const filename = process.platform === 'win32' ? `${tool}.exe` : tool
  for (const directory of search.split(path.delimiter)) {
    // Empty and relative PATH entries must not execute a binary from the project.
    if (!directory || !path.isAbsolute(directory) || directory.includes('\0')) continue
    try { return await executable(path.join(directory, filename), tool) } catch { /* Continue searching trusted absolute PATH entries. */ }
  }
  throw new ToolError('tool-missing', tool)
}

/** Optional script provider directories are never discovered from PATH or started here. */
export async function locateYouTubePotProvider(env: NodeJS.ProcessEnv = process.env, context: ToolContext = {}): Promise<YouTubePotProvider | undefined> {
  const explicit = env.STREAM_SYNC_POT_PLUGIN_DIR || env.STREAM_SYNC_POT_SERVER_HOME
  const pluginDir = explicit ? env.STREAM_SYNC_POT_PLUGIN_DIR?.trim() : context.bundledDir ? path.join(context.bundledDir, 'provider', 'plugin') : undefined
  const serverHome = explicit ? env.STREAM_SYNC_POT_SERVER_HOME?.trim() : context.bundledDir ? path.join(context.bundledDir, 'provider', 'server') : undefined
  if (!pluginDir || !serverHome) return undefined
  // yt-dlp parses commas/semicolons inside extractor-args instead of passing them literally.
  if ([pluginDir, serverHome].some(candidate => !path.isAbsolute(candidate) || /[\0\r\n;,]/.test(candidate))) return undefined
  try {
    const [plugin, server] = await Promise.all([realpath(pluginDir), realpath(serverHome)])
    if (!(await stat(plugin)).isDirectory() || !(await stat(server)).isDirectory()) return undefined
    if (!(await stat(path.join(server, 'build', 'generate_once.js'))).isFile()) return undefined
    await Promise.all([access(plugin, constants.R_OK), access(server, constants.R_OK), access(path.join(server, 'build', 'generate_once.js'), constants.R_OK)])
    return { pluginDir: plugin, serverHome: server }
  } catch { return undefined }
}

async function executable(candidate: string, tool: ToolName): Promise<string> {
  try {
    const resolved = await realpath(candidate)
    if (!(await stat(resolved)).isFile()) throw new Error('not a file')
    // Batch files require a shell and are intentionally unsupported.
    if (process.platform === 'win32' && path.extname(resolved).toLowerCase() !== '.exe') throw new Error('not a native executable')
    await access(resolved, process.platform === 'win32' ? constants.R_OK : constants.X_OK)
    return resolved
  } catch { throw new ToolError('tool-not-executable', tool) }
}
