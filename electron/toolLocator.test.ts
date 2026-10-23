import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { locateTool, locateYouTubePotProvider, ToolError } from './toolLocator'

const roots: string[] = []
async function fixture(name = 'ffmpeg'): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syncer-tool-'))
  roots.push(root)
  const file = path.join(root, process.platform === 'win32' ? `${name}.exe` : name)
  await writeFile(file, 'fixture only, never execute')
  await chmod(file, 0o700)
  return { root, file }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('tool locator', () => {
  it('prefers explicit settings over environment and PATH', async () => {
    const a = await fixture(), b = await fixture()
    expect(await locateTool('ffmpeg', { ffmpegPath: a.file }, { STREAM_SYNC_FFMPEG: b.file, PATH: b.root })).toBe(a.file)
  })
  it.each(['ffmpeg', 'ffprobe', 'yt-dlp'] as const)('uses the dedicated environment variable for %s', async tool => {
    const f = await fixture(tool)
    const key = tool === 'yt-dlp' ? 'STREAM_SYNC_YTDLP' : `STREAM_SYNC_${tool.toUpperCase()}`
    expect(await locateTool(tool, {}, { [key]: f.file })).toBe(f.file)
  })
  it('searches absolute PATH directories and handles Windows Path casing', async () => {
    const f = await fixture('ffprobe')
    expect(await locateTool('ffprobe', {}, { Path: [path.join(f.root, 'missing'), '.', '', f.root].join(path.delimiter) })).toBe(f.file)
  })
  it('reports a configured missing file instead of falling back silently', async () => {
    const f = await fixture()
    await expect(locateTool('ffmpeg', { ffmpegPath: path.join(f.root, 'missing.exe') }, { PATH: f.root })).rejects.toMatchObject({ code: 'tool-not-executable', tool: 'ffmpeg' })
  })
  it.each(['relative/tool.exe', 'bad\0name'])('rejects a non-absolute or malformed configured path', async candidate => {
    await expect(locateTool('ffmpeg', { ffmpegPath: candidate }, {})).rejects.toMatchObject({ code: 'tool-invalid-path' })
  })
  it('rejects directories', async () => {
    const f = await fixture()
    const directory = path.join(f.root, 'directory.exe')
    await mkdir(directory)
    await expect(locateTool('ffmpeg', { ffmpegPath: directory }, {})).rejects.toMatchObject({ code: 'tool-not-executable' })
  })
  it('returns a serializable structured missing-tool error without environment values', async () => {
    try { await locateTool('yt-dlp', {}, { PATH: 'private-relative-path' }) } catch (error) {
      expect(error).toBeInstanceOf(ToolError)
      expect(JSON.parse(JSON.stringify(error))).toMatchObject({ code: 'tool-missing', tool: 'yt-dlp' })
      expect(String(error)).not.toContain('private-relative-path')
      return
    }
    throw new Error('expected missing tool')
  })
  it.skipIf(process.platform !== 'win32')('rejects batch scripts that would require a shell', async () => {
    const f = await fixture()
    const batch = path.join(f.root, 'ffmpeg.cmd')
    await writeFile(batch, 'exit /b 0')
    await expect(locateTool('ffmpeg', { ffmpegPath: batch }, {})).rejects.toMatchObject({ code: 'tool-not-executable' })
  })
})

describe('optional YouTube PO token script locator', () => {
  it('requires both explicit provider paths without PATH discovery', async () => {
    const f = await fixture()
    expect(await locateYouTubePotProvider({ PATH: f.root })).toBeUndefined()
    expect(await locateYouTubePotProvider({ STREAM_SYNC_POT_PLUGIN_DIR: f.root })).toBeUndefined()
    expect(await locateYouTubePotProvider({ STREAM_SYNC_POT_SERVER_HOME: f.root })).toBeUndefined()
  })

  it('resolves readable provider directories with the one-shot script', async () => {
    const f = await fixture()
    const plugin = path.join(f.root, 'plugins')
    const server = path.join(f.root, 'server home')
    await mkdir(plugin)
    await mkdir(path.join(server, 'build'), { recursive: true })
    await writeFile(path.join(server, 'build', 'generate_once.js'), '// fixture only')
    expect(await locateYouTubePotProvider({ STREAM_SYNC_POT_PLUGIN_DIR: plugin, STREAM_SYNC_POT_SERVER_HOME: server }))
      .toEqual({ pluginDir: plugin, serverHome: server })
  })

  it('silently leaves HLS available for missing or incomplete provider installations', async () => {
    const f = await fixture()
    expect(await locateYouTubePotProvider({ STREAM_SYNC_POT_PLUGIN_DIR: f.root, STREAM_SYNC_POT_SERVER_HOME: f.root })).toBeUndefined()
    expect(await locateYouTubePotProvider({ STREAM_SYNC_POT_PLUGIN_DIR: f.file, STREAM_SYNC_POT_SERVER_HOME: f.root })).toBeUndefined()
  })

  it.each(['relative', 'bad\0path', '/unsafe;path', '/unsafe,path', '/unsafe\npath'])('rejects invalid provider argument path %s', async candidate => {
    expect(await locateYouTubePotProvider({ STREAM_SYNC_POT_PLUGIN_DIR: candidate, STREAM_SYNC_POT_SERVER_HOME: candidate })).toBeUndefined()
  })
})
