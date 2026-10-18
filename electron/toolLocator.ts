import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export type ToolName = 'ffmpeg' | 'ffprobe' | 'yt-dlp'
export interface ToolSettings { ffmpegPath?: string; ffprobePath?: string; ytdlpPath?: string }
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

export async function locateTool(tool: ToolName, settings: ToolSettings = {}, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = settings[SETTING_KEYS[tool]] || env[ENV_KEYS[tool]]
  if (configured) {
    const candidate = configured.trim()
    if (!path.isAbsolute(candidate) || candidate.includes('\0')) throw new ToolError('tool-invalid-path', tool)
    return await executable(candidate, tool)
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
