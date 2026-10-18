import { spawn, type ChildProcess } from 'node:child_process'
import { locateTool, type ToolSettings } from './toolLocator'
import { killProcessTree } from './bufferManager'

export interface YoutubeCookieAccess {
  withTemporaryCookies<T>(platform: 'youtube', callback: (path?: string) => Promise<T>): Promise<T>
}

/** Captured metadata is private and bounded; stderr is classified, never returned. */
export class YtDlpRunner {
  private readonly children = new Set<ChildProcess>()
  private readonly pending = new Set<Promise<unknown>>()
  private disposed = false
  constructor(private readonly options: {
    electronPath: string
    cookies: YoutubeCookieAccess
    settings?: ToolSettings
    env?: NodeJS.ProcessEnv
    spawn?: typeof spawn
    timeoutMs?: number
    killTree?: (child: ChildProcess) => Promise<void>
  }) {}

  async resolve(url: string): Promise<unknown> {
    const operation = this.run(url)
    this.pending.add(operation)
    try { return await operation } finally { this.pending.delete(operation) }
  }

  private async run(url: string): Promise<unknown> {
    if (this.disposed) throw new Error('取流服务已关闭')
    const executable = await locateTool('yt-dlp', this.options.settings, this.options.env)
    return this.options.cookies.withTemporaryCookies('youtube', async (cookiePath) => {
      if (this.disposed) throw new Error('取流服务已关闭')
      const args = [
        '--ignore-config', '--no-cache-dir', '--no-playlist', '--no-progress',
        '--socket-timeout', '20', '--retries', '1', '--extractor-retries', '1',
        '--no-js-runtimes', '--js-runtimes', `node:${this.options.electronPath}`,
        '--no-remote-components', '--skip-download', '-J',
        ...(cookiePath ? ['--cookies', cookiePath] : []), '--', url,
      ]
      // Only this child (and its JS runtime) inherits Electron's Node mode.
      const env = { ...(this.options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8' }
      return new Promise((resolve, reject) => {
        let stdout = ''
        let stderr = ''
        let stopped = false
        const child = (this.options.spawn ?? spawn)(executable, args, {
          env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        })
        this.children.add(child)
        const terminate = () => { void (this.options.killTree ?? killProcessTree)(child).catch(() => { child.kill() }) }
        const timer = setTimeout(() => { stopped = true; terminate() }, this.options.timeoutMs ?? 120_000)
        const finish = () => { clearTimeout(timer); this.children.delete(child) }
        child.stdout?.on('data', (chunk: Buffer) => {
          if (stdout.length + chunk.length > 16 * 1_048_576) { stopped = true; terminate(); return }
          stdout += chunk.toString('utf8')
        })
        child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-32_768) })
        child.once('error', () => { finish(); reject(new Error('无法启动 yt-dlp, 请检查工具路径')) })
        child.once('close', (code) => {
          finish()
          if (stopped || this.disposed) { reject(new Error('yt-dlp 超时或已取消')); return }
          if (code !== 0) {
            reject(new Error(/sign in|not a bot|login|required|members.only|private video/i.test(stderr)
              ? 'YouTube sign in required' : /not (?:currently )?live|recording is not available|live (?:event|stream) (?:has ended|will begin)/i.test(stderr)
                ? 'YouTube not currently live' : 'YouTube 取流失败, 请检查直播状态和网络'))
            return
          }
          try { resolve(JSON.parse(stdout)) } catch { reject(new Error('yt-dlp 返回无效的媒体信息')) }
        })
      })
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.children].map((child) => (this.options.killTree ?? killProcessTree)(child)))
    await Promise.allSettled([...this.pending])
  }
}
