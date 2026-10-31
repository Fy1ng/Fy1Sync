import { build } from 'vite'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
export const defaultDestination = path.join(root, '.packaging', 'team-logos')

/** Compile the production cache unchanged; preparation never owns a separate downloader. */
export async function loadLogoCache(workDir) {
  const directory = path.resolve(workDir ?? process.env.FY1SYNC_LOGO_WORK_DIR
    ?? path.join(root, '.runtime-cache', `prepare-team-logos-${Date.now()}-${randomUUID()}`))
  await mkdir(directory, { recursive: true })
  const entry = path.join(directory, `cache-${randomUUID()}.mjs`)
  const output = `cache-${randomUUID()}.cjs`
  await writeFile(entry, `export * from ${JSON.stringify(path.join(root, 'server', 'esports', 'teamLogos.ts').replaceAll('\\', '/'))};\n`, { flag: 'wx' })
  // Bundled like the Electron build, so the output loads from any directory (a temp one in tests).
  await build({
    configFile: false, root, logLevel: 'warn', ssr: { noExternal: ['undici'] },
    build: {
      ssr: entry, outDir: directory, emptyOutDir: false, minify: false, sourcemap: false, target: 'node24',
      rollupOptions: { external: [/^node:/], output: { format: 'cjs', entryFileNames: output, codeSplitting: false } },
    },
  })
  return import(pathToFileURL(path.join(directory, output)).href)
}

export function validateLogoList(value, normalizeLogoPath) {
  if (value?.schema !== 1 || value.source?.url !== 'https://liquipedia.net/counterstrike/Valve_Regional_Standings'
    || !Number.isSafeInteger(value.source.revision) || !/^\d{4}-\d{2}-\d{2}$/.test(value.source.rankingDate)
    || !Array.isArray(value.teams) || value.teams.length < 50 || value.teams.length > 100) throw new Error('预置队标清单无效')
  const paths = new Set()
  for (const [index, team] of value.teams.entries()) {
    if (team.rank !== index + 1 || typeof team.team !== 'string' || !team.team.trim() || team.team.length > 200
      || normalizeLogoPath(team.path) !== team.path || paths.has(team.path)) throw new Error('预置队标条目无效')
    paths.add(team.path)
  }
  return value
}

async function previousManifest(destination) {
  try {
    const file = path.join(destination, 'manifest.json'), info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 200_000) return null
    const result = JSON.parse(await readFile(file, 'utf8'))
    return result?.schema === 1 && Array.isArray(result.entries) ? result : null
  } catch { return null }
}

async function atomicManifest(destination, manifest) {
  const temporary = path.join(destination, `manifest.${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  await rename(temporary, path.join(destination, 'manifest.json'))
}

/** A valid local image resumes without a request. Missing or invalid images fail the build. */
export async function prepareTeamLogos(options = {}) {
  const startedAt = Date.now(), core = options.core ?? await loadLogoCache(options.workDir)
  const list = validateLogoList(options.list ?? JSON.parse(await readFile(path.join(root, 'packaging', 'team-logos.json'), 'utf8')), core.normalizeLogoPath)
  const destination = path.resolve(options.destination ?? defaultDestination)
  await mkdir(destination, { recursive: true })
  const previous = await previousManifest(destination)
  const oldEntries = new Map((previous?.entries ?? []).filter(entry => entry && typeof entry.key === 'string').map(entry => [entry.key, entry]))
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const cache = new core.TeamLogoCache({ userDataDir: destination, version: pkg.version, ...options.cacheDependencies })
  const entries = [], failures = []
  let downloaded = 0, skipped = 0
  try {
    for (const team of list.teams) {
      const key = core.teamLogoKey(team.path)
      let logo = core.readTeamLogo(destination, key)
      const resumed = !!logo
      if (logo) skipped++
      else {
        cache.get(team.path)
        await cache.idle()
        logo = core.readTeamLogo(destination, key)
        if (logo) downloaded++
      }
      if (!logo) { failures.push(team.team); continue }
      const sha256 = createHash('sha256').update(logo.bytes).digest('hex')
      const extension = core.logoFormat(logo.bytes)
      const file = `events/logos/${key}.${extension}`
      const old = oldEntries.get(key)
      const entry = {
        team: team.team, rank: team.rank, path: team.path, key, sha256, size: logo.bytes.length,
        file, sourceUrl: `https://liquipedia.net${team.path}`,
        downloadedAt: resumed && old?.sha256 === sha256 && typeof old.downloadedAt === 'string' && Number.isFinite(Date.parse(old.downloadedAt))
          ? old.downloadedAt : new Date((await lstat(path.join(destination, file))).mtimeMs).toISOString(),
      }
      entries.push(entry)
      options.onProgress?.({ team: team.team, resumed, completed: entries.length, total: list.teams.length })
    }
  } finally { await cache.dispose() }
  const manifest = { schema: 1, generatedAt: new Date().toISOString(), source: list.source, entries }
  // Persist partial progress for diagnosis and resume, but never package an incomplete list.
  await atomicManifest(destination, manifest)
  const imageBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
  const manifestBytes = Buffer.byteLength(JSON.stringify(manifest, null, 2) + '\n')
  const summary = { downloaded, skipped, total: entries.length, expected: list.teams.length, imageBytes, manifestBytes,
    resourceBytes: imageBytes + manifestBytes, elapsedMs: Date.now() - startedAt, destination, failures }
  options.onSummary?.(summary)
  if (failures.length) throw new Error(`预置队标下载或校验失败: ${failures.join(', ')}`)
  return summary
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await prepareTeamLogos({
      onProgress: ({ team, resumed, completed, total }) => console.log(`[${completed}/${total}] ${resumed ? '复用' : '下载'} ${team}`),
      onSummary: summary => console.log(JSON.stringify(summary, null, 2)),
    })
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
