import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let directory = ''
let runtimePath = ''
const require = createRequire(import.meta.url)

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'stream-syncer-network-runtime-'))
  runtimePath = path.join(directory, 'network-runtime.cjs')
  await build({
    configFile: false, logLevel: 'silent', ssr: { noExternal: ['undici', 'ipaddr.js'] },
    build: {
      ssr: path.resolve('electron/networkRuntime.ts'), target: 'node24', outDir: directory,
      emptyOutDir: false, minify: false,
      rollupOptions: { external: [/^node:/], output: { format: 'cjs', entryFileNames: 'network-runtime.cjs', codeSplitting: false } },
    },
  })
})
afterAll(async () => {
  if (directory && path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('stream-syncer-network-runtime-')) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('patched isolated Electron networking runtime', () => {
  it.each(['direct', 'node-options'] as const)('installs matching globals with %s and survives the malformed encoding regression', async mode => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    const program = `
      import { createRequire } from 'node:module';
      import { Server } from 'node:net';
      import { createServer } from 'node:http';
      let listeners = 0;
      const originalListen = Server.prototype.listen;
      Server.prototype.listen = function () { listeners++; throw new Error('Unexpected runtime listener'); };
      const runtime = createRequire(import.meta.url)(${JSON.stringify(runtimePath)});
      Server.prototype.listen = originalListen;
      for (const name of ['fetch','Headers','Request','Response','FormData','WebSocket']) {
        if (globalThis[name] !== runtime[name]) throw new Error('Mixed networking globals: '+name);
      }
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Encoding':'gzip, gzip, gzip, gzip, gzip, gzip', 'Content-Length':'100' });
        response.flushHeaders();
        setTimeout(() => response.destroy(), 25);
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      let rejected = false;
      try { const response = await fetch('http://127.0.0.1:'+server.address().port+'/fixture'); await response.text(); }
      catch { rejected = true; }
      await new Promise(resolve => setTimeout(resolve, 150));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      console.log(JSON.stringify({ version:runtime.networkRuntimeVersion, electron:process.versions.electron, listeners, rejected, survived:true }));
    `
    const outcome = spawnSync(require('electron') as string, ['--input-type=module', '-e', program], {
      cwd: directory, windowsHide: true, encoding: 'utf8', timeout: 8_000,
      env: {
        ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '',
        NODE_OPTIONS: mode === 'node-options' ? `--require="${runtimePath.replace(/\\/g, '/')}"` : '',
      },
    })
    expect(outcome.error).toBeUndefined()
    expect(outcome.status, outcome.stderr).toBe(0)
    expect(outcome.stderr).toBe('')
    expect(JSON.parse(outcome.stdout.trim())).toEqual({
      version: pkg.dependencies.undici, electron: pkg.devDependencies.electron,
      listeners: 0, rejected: true, survived: true,
    })
  }, 12_000)
})
