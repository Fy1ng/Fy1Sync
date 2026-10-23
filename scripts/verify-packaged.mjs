/** Opt-in local verification only; never loads cookies or a live platform URL. */
import { _electron, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const evidence = path.resolve(root, process.env.STREAM_SYNC_PACKAGE_EVIDENCE ?? '.runtime-cache/p7-20261023')
if (!evidence.startsWith(path.join(root, '.runtime-cache') + path.sep)) throw new Error('Package evidence must be under the local runtime cache')
const report = JSON.parse(await readFile(path.join(evidence, 'package-report.json'), 'utf8'))
const zip = report.artifacts.find(item => item.file.endsWith('.zip')).file
// Each verification extracts into an empty owned directory, never over a prior build.
const extracted = path.join(evidence, 'zip-run-' + randomUUID().slice(0, 8))
await mkdir(extracted)
function run(exe, args, env, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    let out = '', err = ''; const child = spawn(exe, args, { env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill(), timeout)
    child.stdout.on('data', b => { out += b; if (out.length > 32768) child.kill() })
    child.stderr.on('data', b => { err = (err + b).slice(-8192) })
    child.once('error', e => { clearTimeout(timer); reject(e) })
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(`${path.basename(exe)} failed, exit=${code}: ${err}`)) })
  })
}
await run('tar.exe', ['-xf', zip, '-C', extracted], process.env, 180_000)
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^STREAM_SYNC_/i.test(key) && !/^(?:ELECTRON_RUN_AS_NODE|PATH)$/i.test(key)))
cleanEnv.PATH = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') + ';' + (process.env.SystemRoot ?? 'C:\\Windows')
const results = []
for (const [label, folder] of [['unpacked', path.join(root, '.release', 'win-unpacked')], ['zip', extracted]]) {
  const profile = path.join(evidence, `profile-${label}-${randomUUID()}`)
  await mkdir(profile)
  await mkdir(path.join(profile, 'temp'))
  let application
  try {
    const exe = path.join(folder, 'Stream Syncer.exe'), tools = path.join(folder, 'resources', 'tools')
    const runtimeEnv = { ...cleanEnv, TEMP: path.join(profile, 'temp'), TMP: path.join(profile, 'temp') }
    const env = { ...runtimeEnv, STREAM_SYNC_E2E: '1', STREAM_SYNC_OFFLINE_E2E: '1', STREAM_SYNC_USER_DATA_DIR: profile, STREAM_SYNC_DATA_DIR: path.join(profile, 'data') }
    const childEnv = { ...runtimeEnv, ELECTRON_RUN_AS_NODE: '1', XDG_CACHE_HOME: path.join(profile, 'provider-cache') }
    const canvas = await run(exe, ['-e', `const c=require(${JSON.stringify(path.join(tools, 'provider', 'server', 'node_modules', 'canvas'))});const b=c.createCanvas(8,8).toBuffer('image/png');console.log(JSON.stringify({canvas:c.version,bytes:b.length}))`], childEnv)
    application = await _electron.launch({ executablePath: exe, env, args: ['--mute-audio'], timeout: 30_000 })
    const page = await application.firstWindow({ timeout: 30_000 })
    await page.waitForURL('app://app/**')
    let requests = 0; const errors = []
    page.on('request', request => { if (/^https?:/.test(request.url())) requests++ })
    page.on('pageerror', error => errors.push(error.message))
    await page.waitForFunction(() => !!window.streamSyncer)
    const status = await page.evaluate(() => window.streamSyncer.invoke('getToolsStatus', undefined))
    if (!status.ok || status.value.tools.some(tool => tool.source !== 'bundled' || !tool.available || /失败|不可用/.test(tool.version)) || !status.value.provider.available || status.value.provider.source !== 'bundled' || status.value.fixturesAvailable) throw new Error('Packaged tools were not selected from bundled resources')
    const provider = await run(exe, [path.join(tools, 'provider', 'server', 'build', 'generate_once.js'), '--version'], childEnv)
    if (provider !== '2.0.2' || JSON.parse(canvas).canvas !== '3.2.3') throw new Error('Unexpected packaged provider/native version')
    const cachePrivate = await application.evaluate((_electron, cache) => new Promise((resolve, reject) => {
      const { spawn } = process.getBuiltinModule('node:child_process')
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const script = "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$acl=Get-Acl -LiteralPath $env:STREAM_SYNC_CACHE_ACL_PATH;$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|Where-Object {$_.AccessControlType -eq 'Allow'});if(-not $acl.AreAccessRulesProtected -or @($rules|Where-Object {$_.IdentityReference.Value -ne $sid -and -not $_.IdentityReference.Value.StartsWith('S-1-15-3-')}).Count -ne 0){exit 1};Write-Output 'PRIVATE_OK'"
      const child = spawn(systemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, shell: false, env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath')), STREAM_SYNC_CACHE_ACL_PATH: cache }, stdio: ['ignore', 'pipe', 'ignore'],
      })
      let output = ''; child.stdout.on('data', b => output += b)
      child.once('error', reject); child.once('close', code => code === 0 && output.trim() === 'PRIVATE_OK' ? resolve(true) : reject(new Error('Provider cache is not private')))
    }), path.join(profile, 'provider-cache'))
    await expect(page.locator('.source-tests')).toHaveCount(0)
    // The user-facing local file input creates an object URL. No media fixture is shipped in the package.
    const media = path.join(root, 'public', 'test-sources', 'official.mp4')
    await stat(media)
    const copiedMedia = path.join(profile, 'remux.mp4')
    await run(path.join(tools, 'ffmpeg', 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', media, '-t', '2', '-c', 'copy', copiedMedia], cleanEnv)
    const probe = JSON.parse(await run(path.join(tools, 'ffmpeg', 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', copiedMedia], cleanEnv))
    if (!probe.streams?.some(stream => stream.width === 1280 && stream.height === 720)) throw new Error('Packaged ffmpeg/ffprobe remux failed')
    await page.locator('.source-panel').first().locator('input[type=file]').setInputFiles(media)
    await page.getByRole('button', { name: '完成', exact: true }).click()
    const video = page.locator('video.media-element[data-role=official]')
    await expect.poll(() => video.evaluate(v => v.readyState)).toBeGreaterThanOrEqual(2)
    await page.locator('.play-button').click()
    const first = await video.evaluate(v => v.currentTime)
    await expect.poll(() => video.evaluate(v => v.currentTime), { timeout: 12_000 }).toBeGreaterThan(first + 2)
    const playback = await video.evaluate(v => ({ width: v.videoWidth, height: v.videoHeight, currentTime: v.currentTime, paused: v.paused }))
    await page.screenshot({ path: path.join(evidence, `${label}-playback.png`) })
    if (requests || errors.length) throw new Error('Packaged offline playback emitted external requests or page errors')
    const result = { label, executable: exe, packageArtifacts: report.artifacts, status: status.value, canvas: JSON.parse(canvas), provider, providerCachePrivate: cachePrivate, remuxProbe: probe, playback, externalRequests: requests, pageErrors: errors }
    results.push(result)
    await writeFile(path.join(evidence, `${label}-runtime.json`), JSON.stringify(result, null, 2) + '\n')
  } finally {
    await application?.close()
    if (path.dirname(profile) !== evidence || !path.basename(profile).startsWith('profile-')) throw new Error('Unsafe packaged profile cleanup')
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
}
await writeFile(path.join(evidence, 'packaged-runtime.json'), JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify(results, null, 2))
