import { spawn } from 'node:child_process'
import { killProcessTree } from './bufferManager'

/** Fixed arguments, bounded output/time, no shell, and no upstream request. */
export function toolVersion(executable: string, ytdlp = false): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '', settled = false, stopped = false
    const child = spawn(executable, ytdlp ? ['--ignore-config', '--no-cache-dir', '--version'] : ['-version'], { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = (value?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (value) resolve(value); else reject(new Error('工具版本验证失败'))
    }
    const terminate = () => {
      if (stopped || settled) return
      stopped = true
      void killProcessTree(child).catch(() => { child.kill('SIGKILL') }).finally(() => finish())
    }
    const timer = setTimeout(terminate, 10_000)
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > 16_384) terminate()
    })
    child.stderr.on('data', () => {})
    child.once('error', () => finish())
    child.once('close', code => {
      const version = ytdlp ? output.trim() : /^(?:ffmpeg|ffprobe) version ([A-Za-z0-9.+_-]{1,100})\b/.exec(output)?.[1]
      finish(!stopped && code === 0 && version && (ytdlp ? /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(version) : true) ? version : undefined)
    })
  })
}
