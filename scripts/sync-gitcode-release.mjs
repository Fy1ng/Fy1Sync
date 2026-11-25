import { lstat, readFile, readdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectedReleasePackages, validateReleaseVersion } from './render-release-notes.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const API_ORIGIN = 'https://api.gitcode.com'
const DEFAULT_OWNER = 'Fy1ng'
const DEFAULT_REPO = 'Fy1Sync'

function assertSafeHttpsUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL returned by GitCode API')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    throw new Error('GitCode upload URL must use standard HTTPS without embedded credentials')
  }
  if (parsed.hostname === 'localhost' || net.isIP(parsed.hostname) !== 0) {
    throw new Error('GitCode upload URL must use a public domain hostname')
  }
  return parsed.href
}

async function verifyLocalArtifacts(directory, version) {
  const expected = [...expectedReleasePackages(version), 'SHA256SUMS.txt'].sort()
  const actual = (await readdir(directory)).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Artifact directory must contain exact 13 release files for ${version}`)
  }
  const files = []
  for (const name of expected) {
    const filePath = path.join(directory, name)
    const info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) {
      throw new Error(`Invalid release artifact file: ${name}`)
    }
    files.push({ name, filePath, size: info.size })
  }
  return files
}

async function apiJson(fetchImpl, endpoint, token, init = {}) {
  const url = `${API_ORIGIN}${endpoint}`
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  if (response.status === 404 && init.allowNotFound) {
    return null
  }
  if (!response.ok) {
    throw new Error(`GitCode API ${init.method ?? 'GET'} ${endpoint} failed with HTTP ${response.status}`)
  }
  return await response.json()
}

export async function syncGitcodeRelease({
  version,
  directory,
  notes,
  token = process.env.GITCODE_TOKEN ?? '',
  owner = DEFAULT_OWNER,
  repo = DEFAULT_REPO,
  targetCommitish = 'main',
  ifConfigured = false,
  fetchImpl = globalThis.fetch,
}) {
  validateReleaseVersion(version)
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('Invalid GitCode repository owner or name')
  }
  const cleanToken = typeof token === 'string' ? token.trim() : ''
  if (!cleanToken) {
    if (ifConfigured) {
      return { skipped: true, uploaded: [], reused: [] }
    }
    throw new Error('GITCODE_TOKEN is required to sync release artifacts to GitCode')
  }
  if (typeof notes !== 'string' || !notes.trim()) {
    throw new Error('Release notes body must not be empty')
  }

  const files = await verifyLocalArtifacts(directory, version)
  const tag = `v${version}`
  const title = `Fy1Sync ${version}`
  const repoBase = `/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`

  let release = await apiJson(fetchImpl, `${repoBase}/releases/tags/${encodeURIComponent(tag)}`, cleanToken, { allowNotFound: true })
  if (!release) {
    release = await apiJson(fetchImpl, `${repoBase}/releases`, cleanToken, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: tag,
        name: title,
        body: notes,
        target_commitish: targetCommitish,
        prerelease: false,
      }),
    })
  } else if (release.id !== undefined && release.id !== null) {
    release = await apiJson(fetchImpl, `${repoBase}/releases/${encodeURIComponent(String(release.id))}`, cleanToken, {
      method: 'PATCH',
      body: JSON.stringify({
        tag_name: tag,
        name: title,
        body: notes,
        prerelease: false,
      }),
    })
  }

  const existingAssets = new Map(
    (Array.isArray(release?.assets) ? release.assets : [])
      .filter(asset => asset && typeof asset.name === 'string')
      .map(asset => [asset.name, asset]),
  )

  const uploaded = []
  const reused = []
  for (const item of files) {
    const existing = existingAssets.get(item.name)
    if (existing && Number(existing.size) === item.size) {
      reused.push(item.name)
      continue
    }
    const ticket = await apiJson(
      fetchImpl,
      `${repoBase}/releases/${encodeURIComponent(tag)}/upload_url?file_name=${encodeURIComponent(item.name)}`,
      cleanToken,
    )
    const uploadUrl = assertSafeHttpsUrl(ticket?.url)
    const extraHeaders = ticket?.headers && typeof ticket.headers === 'object' && !Array.isArray(ticket.headers)
      ? Object.fromEntries(Object.entries(ticket.headers).filter(([k, v]) => typeof k === 'string' && typeof v === 'string'))
      : {}
    const payload = await readFile(item.filePath)
    if (payload.byteLength !== item.size) {
      throw new Error(`Artifact size changed during upload: ${item.name}`)
    }
    const putResponse = await fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(payload.byteLength),
        ...extraHeaders,
      },
      body: payload,
    })
    if (!putResponse.ok) {
      throw new Error(`Uploading ${item.name} to GitCode storage failed with HTTP ${putResponse.status}`)
    }
    uploaded.push(item.name)
  }

  return { skipped: false, tag, uploaded, reused }
}

function parseCliArgs(argv) {
  const options = {
    dir: path.join(root, '.release'),
    notesFile: undefined,
    version: undefined,
    targetCommitish: 'main',
    ifConfigured: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dir') options.dir = path.resolve(root, argv[++i])
    else if (arg === '--notes-file') options.notesFile = path.resolve(root, argv[++i])
    else if (arg === '--version') options.version = argv[++i]
    else if (arg === '--target-commitish') options.targetCommitish = argv[++i]
    else if (arg === '--if-configured') options.ifConfigured = true
    else throw new Error(`Unsupported argument: ${arg}`)
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseCliArgs(process.argv.slice(2))
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const version = validateReleaseVersion(args.version ?? pkg.version)
  const notesPath = args.notesFile ?? path.join(root, 'packaging', 'releases', `${version}.md`)
  const notes = await readFile(notesPath, 'utf8')
  const outcome = await syncGitcodeRelease({
    version,
    directory: args.dir,
    notes,
    targetCommitish: args.targetCommitish,
    ifConfigured: args.ifConfigured,
  })
  if (outcome.skipped) {
    console.log('未配置 GITCODE_TOKEN，跳过 GitCode Release 自动同步')
  } else {
    console.log(`GitCode ${outcome.tag} 同步完成: 上传 ${outcome.uploaded.length} 个文件，复用 ${outcome.reused.length} 个已存在文件`)
  }
}
