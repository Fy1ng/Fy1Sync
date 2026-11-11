import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Page } from '@playwright/test'

const mediaRoot = fileURLToPath(new URL('./.data/live-clock-hls-v1/', import.meta.url))
const prefix = '/test-sources/live-clock/'
const segmentSeconds = 2
const clockDuration = 110

export interface LiveClockRequest {
  at: number
  role: string
  resource: string
  status: number
  delayMs: number
  sequence?: number
  playlistStart?: number
  playlistEnd?: number
}

async function prepareMedia(): Promise<void> {
  if (existsSync(path.join(mediaRoot, 'seg-054.ts'))
    && (await readFile(path.join(mediaRoot, 'index.m3u8'), 'utf8').catch(() => '')).includes('#EXT-X-ENDLIST')) return
  await mkdir(mediaRoot, { recursive: true })
  const font = (process.env.STREAM_SYNC_FONT || (process.platform === 'win32'
    ? 'C:/Windows/Fonts/consola.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'))
    .replace(/\\/g, '/').replace(/:/g, '\\:')
  const remaining = 'max(0,110-floor(t))'
  const clock = `%{eif\\:floor(${remaining}/60)\\:d}\\:%{eif\\:mod(${remaining},60)\\:d\\:2}`
  const filter = `drawbox=x=245:y=16:w=170:h=76:color=black:t=fill,drawtext=fontfile='${font}':text='${clock}':fontcolor=white:fontsize=52:x=270:y=25`
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.STREAM_SYNC_FIXTURE_FFMPEG || process.env.STREAM_SYNC_FFMPEG || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30',
      '-t', String(clockDuration), '-vf', filter, '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-f', 'hls', '-hls_time', String(segmentSeconds), '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments', '-hls_segment_filename', path.join(mediaRoot, 'seg-%03d.ts'),
      path.join(mediaRoot, 'index.m3u8'),
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let errors = ''
    child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-4096) })
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Live clock fixture encoding timed out')) }, 90_000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(errors)) })
  })
}

/** Real HTTP playlists/segments, bridged through the app's existing local fixture origin. */
export async function startLiveClockFixture(page: Page): Promise<{
  requests: LiveClockRequest[]
  armRewindFault(maxSequence: number, delayMs: number, failOnce?: boolean): void
  close(): Promise<void>
}> {
  await prepareMedia()
  const started = Date.now()
  const requests: LiveClockRequest[] = []
  let fault: { maxSequence: number; delayMs: number; failOnce: boolean; failed: boolean; delayed: boolean } | null = null
  const server = createServer(async (request, response) => {
    const match = /^\/(official|commentary)\/(index\.m3u8|seg-(\d{3})\.ts)$/.exec(new URL(request.url!, 'http://fixture').pathname)
    if (!match) { response.writeHead(404).end(); return }
    const role = match[1]!, resource = match[2]!
    const elapsed = (Date.now() - started) / 1000
    const log: LiveClockRequest = { at: Date.now(), role, resource, status: 200, delayMs: 0 }
    response.setHeader('Cache-Control', 'no-store')
    if (resource === 'index.m3u8') {
      const end = Math.min(Math.floor((36 + elapsed) / segmentSeconds), clockDuration / segmentSeconds)
      const begin = Math.max(0, end - 20)
      log.playlistStart = begin * segmentSeconds; log.playlistEnd = end * segmentSeconds
      requests.push(log)
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${begin}`, '#EXT-X-INDEPENDENT-SEGMENTS']
      for (let index = begin; index < end; index++) lines.push('#EXTINF:2.000000,', `seg-${String(index).padStart(3, '0')}.ts`)
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(lines.join('\n') + '\n')
      return
    }
    const sequence = Number(match[3]); log.sequence = sequence
    if (role === 'official' && fault && sequence <= fault.maxSequence) {
      if (fault.failOnce && !fault.failed) {
        fault.failed = true; log.status = 503; requests.push(log)
        response.writeHead(503).end('Transient fixture fragment failure'); return
      }
      if (!fault.delayed) {
        fault.delayed = true; log.delayMs = fault.delayMs
        await new Promise(resolve => setTimeout(resolve, fault!.delayMs))
      }
    }
    requests.push(log)
    try { response.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(await readFile(path.join(mediaRoot, resource))) }
    catch { response.writeHead(404).end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Live clock fixture did not bind')
  const route = `app://app${prefix}**`
  await page.route(route, async intercepted => {
    const pathname = new URL(intercepted.request().url()).pathname
    const upstream = await fetch(`http://127.0.0.1:${address.port}/${pathname.slice(prefix.length)}`)
    await intercepted.fulfill({ status: upstream.status, contentType: upstream.headers.get('content-type') || 'text/plain',
      headers: { 'Cache-Control': 'no-store' }, body: Buffer.from(await upstream.arrayBuffer()) })
  })
  return {
    requests,
    armRewindFault(maxSequence, delayMs, failOnce = false) { fault = { maxSequence, delayMs, failOnce, failed: false, delayed: false } },
    async close() {
      await page.unroute(route)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
