/**
 * The deployment claim, tested the way a user meets it.
 *
 * `scripts/build-server.mjs` promises `node dist/server/index.mjs` runs with no TypeScript
 * loader, no `node_modules` and nothing to install, and it checks that against its own
 * esbuild metafile. That check knows what esbuild marked external; it does not know whether
 * the file starts. This one copies `dist/` somewhere with no `node_modules` and no
 * `package.json`, boots it, and asks it for a page — which is the whole deployment story.
 *
 * Skipped when `dist/` is absent: `npx vitest run` on a fresh clone has nothing to test yet,
 * and a hard failure there would be reporting a missing build as a broken server.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const bundle = join(repoRoot, 'dist', 'server', 'index.mjs')
const built = existsSync(bundle)

/**
 * What `spawn` returns for `stdio: ['ignore', 'pipe', 'pipe']`: two readable pipes and no
 * stdin. The server is never written to, so closing that end keeps it from waiting on input.
 */
type Server = ChildProcessByStdio<null, Readable, Readable>

/** Wait for the startup banner and pull the URL out of it. */
function waitForUrl(child: Server, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`服务端未在 ${timeoutMs}ms 内启动，输出：\n${output}`))
    }, timeoutMs)
    const finish = (error: Error | null, url?: string): void => {
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(url ?? '')
    }
    const scan = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      // The banner prints the bound port, which is what port 0 makes unpredictable.
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output)
      if (match) finish(null, `http://127.0.0.1:${match[1]}`)
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      finish(new Error(`服务端退出（code ${code}），输出：\n${output}`))
    })
  })
}

describe.skipIf(!built)('deployed bundle', () => {
  let dir = ''
  let child: Server | null = null
  let base = ''

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stream-sync-deploy-'))
    // Only `dist`. No `node_modules`, no `package.json`, no source tree — if the bundle
    // needs any of them, it fails here rather than on someone else's machine.
    await cp(join(repoRoot, 'dist'), join(dir, 'dist'), { recursive: true })

    const started = spawn(process.execPath, [join('dist', 'server', 'index.mjs')], {
      cwd: dir,
      env: {
        ...process.env,
        // 0 keeps the suite off a fixed port, so a running dev server cannot fail it.
        STREAM_SYNC_PORT: '0',
        STREAM_SYNC_STRICT_PORT: '1',
        STREAM_SYNC_HOST: '127.0.0.1',
        STREAM_SYNC_DATA_DIR: join(dir, 'data'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Assigned before the await so a startup failure still leaves `afterAll` something to
    // kill — otherwise a server that printed nothing would be left running.
    child = started
    base = await waitForUrl(started, 20_000)
  }, 40_000)

  afterAll(async () => {
    if (child && child.exitCode === null) {
      // `kill` only signals. Windows holds a lock on the child's cwd until it is really
      // gone, and removing the directory under it fails with EBUSY.
      const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()))
      child.kill()
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
    }
    // `maxRetries` covers the gap between process exit and the handle being released.
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }, 30_000)

  it('starts from dist alone and answers', async () => {
    const response = await fetch(`${base}/api/health`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, version: expect.any(String) })
  })

  it('serves the built client, not just the API', async () => {
    const response = await fetch(`${base}/`)

    expect(response.status).toBe(200)
    // A 503 here is the "run npm run build" page, which would mean the bundle came up but
    // cannot find the client next to it — deployable server, undeployable product.
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('<div id="root">')
  })

  it('serves the editor route from the same bundle', async () => {
    const response = await fetch(`${base}/admin`)

    // Client-side route, so the SPA fallback has to answer it rather than 404.
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
  })

  it('still separates unknown API routes from the SPA fallback', async () => {
    const response = await fetch(`${base}/api/definitely-not-a-route`)

    // If the fallback swallowed this, every API typo would return the app shell and the
    // client would parse HTML as JSON.
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('imports nothing outside Node core', async () => {
    const source = await readFile(bundle, 'utf8')

    const bare = [...source.matchAll(/^import\s[^;]*?from\s*["']([^"']+)["']/gm)]
      .map((match) => match[1] ?? '')
      .filter((name) => !name.startsWith('node:'))

    // Redundant with the boot above on this machine, but it names the culprit instead of
    // leaving a stack trace, and it catches a dependency that happens to be installed here.
    expect(bare).toEqual([])
  })
})

describe.skipIf(built)('deployed bundle (skipped)', () => {
  it('needs a build first', () => {
    // Present so a run without `dist/` says why rather than silently covering nothing.
    expect(built).toBe(false)
  })
})
