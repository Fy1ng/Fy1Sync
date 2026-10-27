/** One explicit, read-only online call per interface, with a persistent isolated rate-limit directory. */
import { build } from 'vite'
import { install } from 'undici'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, resolve, sep } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const evidence = resolve(root, '.runtime-cache', 'fy1sync-20261027', 'schedule')
if (!evidence.startsWith(join(root, '.runtime-cache') + sep)) throw new Error('Invalid schedule verification directory')
await mkdir(evidence, { recursive: true })
await build({ configFile: false, root, ssr: { noExternal: ['parse5', 'entities', 'undici'] },
  build: { ssr: join(root, 'server', 'esports', 'schedule.ts'), outDir: evidence, emptyOutDir: false, minify: false, target: 'node24',
    rollupOptions: { external: [/^node:/], output: { format: 'cjs', entryFileNames: 'schedule.cjs' } } } })
const require = createRequire(import.meta.url)
const { EsportsService } = require(join(evidence, 'schedule.cjs'))
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
install()
const online = process.argv.includes('--online')
const calls = []
const fixture = JSON.parse(await readFile(join(root, 'server', 'esports', 'fixtures', 'liquipedia-matches.json'), 'utf8'))
const service = new EsportsService({ userDataDir: join(evidence, online ? 'online-profile' : 'offline-profile'), version,
  ...(!online ? { now: () => Date.parse('2026-10-26T20:00:00Z'), resolve: async () => ['93.184.216.34'] } : {}),
  request: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push({ at: new Date().toISOString(), host: url.hostname, path: url.pathname, method: init?.method ?? 'GET' })
    if (online) return fetch(input, init)
    return new Response(JSON.stringify(url.hostname === 'liquipedia.net' ? fixture
      : url.hostname === 'gql.twitch.tv' ? { data: { user: { stream: { title: '[A] Offline fixture', type: 'live' } } } }
        : { title: '[B] Offline fixture' }), { headers: { 'content-type': 'application/json' } })
  },
})
try {
  const schedule = await service.getCs2Schedule({ refresh: true })
  const selectedStreams = [...new Map(schedule.matches.slice(0, 3).flatMap(match => match.streams)
    .map(({ platform, channel, videoId }) => [JSON.stringify([platform, channel, videoId]), { platform, channel, videoId }])).values()].slice(0, 12)
  // Even an upstream schedule outage must not skip the independent title check.
  // These two public inputs are from the recorded handoff, not claimed as current matches.
  const streams = selectedStreams.length ? selectedStreams : [
    { platform: 'youtube', channel: 'PGL', videoId: 'sx5tneE-ILg' },
    { platform: 'twitch', channel: 'PGL_CS2', videoId: null },
  ]
  const titles = await service.getStreamTitles({ streams })
  const report = { online, checkedAt: new Date().toISOString(), calls,
    schedule: { ...schedule, totalMatches: schedule.matches.length, matches: schedule.matches.slice(0, 3) },
    titleInputsSource: selectedStreams.length ? 'current-schedule' : 'recorded-handoff', titles }
  const destination = join(evidence, online ? 'online-report.json' : 'offline-report.json')
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  if (schedule.error || !schedule.matches.length) process.exitCode = 1
} finally { await service.dispose() }
