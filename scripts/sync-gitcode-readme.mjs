import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  GITHUB_REPO,
  GITCODE_REPO,
  validateReleaseVersion,
  verifyReadmeDownloadLinks,
} from './render-release-notes.mjs'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const SHA_PATTERN = /^[0-9a-f]{40}$/i
const DEFAULT_BOT_NAME = 'Fy1Sync Release Bot'
const DEFAULT_BOT_EMAIL = 'bot@fy1ng.cn'

const GITHUB_INSTALL_NOTE =
  'GitHub 发布页底部文件超过 10 个会默认折叠 Windows 安装包, 直接点页面顶部的下载按钮即可; 国内访问 GitHub 较慢时可前往 [GitCode 镜像](https://gitcode.com/Fy1ng/Fy1Sync/releases).'
const GITCODE_INSTALL_NOTE =
  '直接点页面顶部的下载按钮即可, 也可以到 [Releases 页面](https://gitcode.com/Fy1ng/Fy1Sync/releases) 按系统选择安装包.'

function assertSafeGitArg(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) {
    throw new Error(`Invalid git ${name}: ${String(value)}`)
  }
  return value.trim()
}

async function runGit(args, { cwd, env = process.env, input, encoding = 'utf8' } = {}) {
  return await new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        env,
        encoding: encoding === 'buffer' ? 'buffer' : encoding,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '')
          error.stderrText = detail.trim()
          error.exitCode = typeof error.code === 'number' ? error.code : null
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      },
    )
    if (input !== undefined && child.stdin) {
      child.stdin.end(input)
    }
  })
}

async function isAncestor(cwd, ancestor, descendant, env) {
  try {
    await runGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd, env })
    return true
  } catch (error) {
    if (error.exitCode === 1) return false
    throw error
  }
}

async function readGitConfigValue(cwd, key, env) {
  try {
    const { stdout } = await runGit(['config', '--get', key], { cwd, env })
    return stdout.trim()
  } catch (error) {
    if (error.exitCode === 1) return ''
    throw error
  }
}

/**
 * Convert a verified GitHub README.md into the GitCode mirror variant while preserving line endings.
 */
export function renderGitcodeReadme(githubReadme, version) {
  validateReleaseVersion(version)
  verifyReadmeDownloadLinks(githubReadme, version, { host: 'github' })

  const githubDownloadPrefix = `${GITHUB_REPO}/releases/download/v${version}/`
  const gitcodeDownloadPrefix = `${GITCODE_REPO}/releases/download/v${version}/`

  const converted = githubReadme
    .replaceAll(githubDownloadPrefix, gitcodeDownloadPrefix)
    .replaceAll(`href="${GITHUB_REPO}/releases/latest"`, `href="${GITCODE_REPO}/releases"`)
    .replaceAll(`href="${GITHUB_REPO}/releases"`, `href="${GITCODE_REPO}/releases"`)
    .replaceAll(`[Releases 页面](${GITHUB_REPO}/releases/latest)`, `[Releases 页面](${GITCODE_REPO}/releases)`)
    .replace(GITHUB_INSTALL_NOTE, GITCODE_INSTALL_NOTE)

  verifyReadmeDownloadLinks(converted, version, { host: 'gitcode' })
  return converted
}

/**
 * Create (or reuse when identical and already fast-forward) a GitCode mirror commit from sourceRef.
 */
export async function buildGitcodeMirrorCommit({
  cwd = root,
  sourceRef = 'HEAD',
  remoteTip = null,
  version,
  env = process.env,
}) {
  const safeSource = assertSafeGitArg(sourceRef, 'sourceRef')
  if (remoteTip !== null && remoteTip !== undefined && !SHA_PATTERN.test(remoteTip)) {
    throw new Error(`Invalid remoteTip SHA: ${String(remoteTip)}`)
  }

  const { stdout: resolvedCommit } = await runGit(['rev-parse', '--verify', `${safeSource}^{commit}`], { cwd, env })
  const sourceCommit = resolvedCommit.trim()

  let resolvedVersion = version
  if (!resolvedVersion) {
    const { stdout: pkgJson } = await runGit(['show', `${sourceCommit}:package.json`], { cwd, env })
    resolvedVersion = JSON.parse(pkgJson).version
  }
  validateReleaseVersion(resolvedVersion)

  const { stdout: readmeBuffer } = await runGit(['show', `${sourceCommit}:README.md`], {
    cwd,
    env,
    encoding: 'buffer',
  })
  const sourceReadme = readmeBuffer.toString('utf8')
  const gitcodeReadme = renderGitcodeReadme(sourceReadme, resolvedVersion)

  const { stdout: blobOutput } = await runGit(['hash-object', '-w', '--stdin'], {
    cwd,
    env,
    input: Buffer.from(gitcodeReadme, 'utf8'),
  })
  const blobSha = blobOutput.trim()

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fy1sync-gitcode-index-'))
  let newTree
  try {
    const indexFile = path.join(tempDir, 'index')
    const indexEnv = { ...env, GIT_INDEX_FILE: indexFile }
    await runGit(['read-tree', sourceCommit], { cwd, env: indexEnv })
    await runGit(['update-index', '--cacheinfo', `100644,${blobSha},README.md`], { cwd, env: indexEnv })
    const { stdout: treeOutput } = await runGit(['write-tree'], { cwd, env: indexEnv })
    newTree = treeOutput.trim()
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }

  if (remoteTip) {
    const { stdout: remoteTreeOutput } = await runGit(['rev-parse', '--verify', `${remoteTip}^{tree}`], { cwd, env })
    const remoteTree = remoteTreeOutput.trim()
    if (remoteTree === newTree && (await isAncestor(cwd, sourceCommit, remoteTip, env))) {
      return {
        commit: remoteTip,
        sourceCommit,
        tree: newTree,
        parents: [],
        created: false,
        upToDate: true,
      }
    }
  }

  let parents
  if (!remoteTip || remoteTip === sourceCommit || (await isAncestor(cwd, remoteTip, sourceCommit, env))) {
    parents = [sourceCommit]
  } else {
    parents = [remoteTip, sourceCommit]
  }

  const authorName = env.GIT_AUTHOR_NAME || (await readGitConfigValue(cwd, 'user.name', env)) || DEFAULT_BOT_NAME
  const authorEmail = env.GIT_AUTHOR_EMAIL || (await readGitConfigValue(cwd, 'user.email', env)) || DEFAULT_BOT_EMAIL
  const committerName = env.GIT_COMMITTER_NAME || authorName
  const committerEmail = env.GIT_COMMITTER_EMAIL || authorEmail

  const commitEnv = {
    ...env,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: committerName,
    GIT_COMMITTER_EMAIL: committerEmail,
  }
  const commitArgs = ['commit-tree', newTree]
  for (const parent of parents) {
    commitArgs.push('-p', parent)
  }
  commitArgs.push('-m', `chore(gitcode): 同步主线并切换 README 为 GitCode 下载直链 (${sourceCommit.slice(0, 7)})`)

  const { stdout: commitOutput } = await runGit(commitArgs, { cwd, env: commitEnv })
  return {
    commit: commitOutput.trim(),
    sourceCommit,
    tree: newTree,
    parents,
    created: true,
    upToDate: false,
  }
}

/**
 * Sync sourceRef to a GitCode branch with a GitCode-only README.md via fast-forward push.
 */
export async function syncGitcodeBranch({
  cwd = root,
  remote = 'gitcode',
  sourceRef = 'HEAD',
  targetBranch = 'main',
  tag,
  dryRun = false,
  env = process.env,
} = {}) {
  const safeRemote = assertSafeGitArg(remote, 'remote')
  const safeSource = assertSafeGitArg(sourceRef, 'sourceRef')
  const safeBranch = assertSafeGitArg(targetBranch, 'targetBranch')
  const safeTag = tag ? assertSafeGitArg(tag, 'tag') : null

  const targetRef = `refs/heads/${safeBranch}`
  const { stdout: lsRemoteOut } = await runGit(['ls-remote', '--heads', safeRemote, targetRef], { cwd, env })
  const firstLine = lsRemoteOut.trim().split(/\r?\n/).find(Boolean)
  const remoteTip = firstLine ? firstLine.split(/\s+/)[0] : null
  if (remoteTip) {
    await runGit(['fetch', '--no-tags', safeRemote, targetRef], { cwd, env })
  }

  const buildResult = await buildGitcodeMirrorCommit({
    cwd,
    sourceRef: safeSource,
    remoteTip,
    env,
  })

  const refspecs = []
  if (!buildResult.upToDate) {
    refspecs.push(`${buildResult.commit}:${targetRef}`)
  }
  if (safeTag) {
    await runGit(['rev-parse', '--verify', `refs/tags/${safeTag}`], { cwd, env })
    refspecs.push(`refs/tags/${safeTag}:refs/tags/${safeTag}`)
  }

  if (dryRun || refspecs.length === 0) {
    return {
      ...buildResult,
      remote: safeRemote,
      targetBranch: safeBranch,
      tag: safeTag,
      refspecs,
      dryRun,
      pushed: false,
    }
  }

  await runGit(['push', safeRemote, ...refspecs], { cwd, env })
  return {
    ...buildResult,
    remote: safeRemote,
    targetBranch: safeBranch,
    tag: safeTag,
    refspecs,
    dryRun,
    pushed: true,
  }
}

function parseCliArgs(argv) {
  const options = {
    remote: 'gitcode',
    source: 'HEAD',
    sourceExplicit: false,
    branch: 'main',
    tag: undefined,
    dryRun: false,
    printReadme: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--remote') options.remote = argv[++i]
    else if (arg === '--source') {
      options.source = argv[++i]
      options.sourceExplicit = true
    } else if (arg === '--branch') options.branch = argv[++i]
    else if (arg === '--tag') options.tag = argv[++i]
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--print-readme') options.printReadme = true
    else throw new Error(`Unsupported argument: ${arg}`)
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseCliArgs(process.argv.slice(2))
  if (args.printReadme) {
    let readmeText
    let version
    if (args.sourceExplicit) {
      const safeSource = assertSafeGitArg(args.source, 'sourceRef')
      const { stdout: pkgJson } = await runGit(['show', `${safeSource}:package.json`], { cwd: root })
      version = JSON.parse(pkgJson).version
      const { stdout: readmeBuf } = await runGit(['show', `${safeSource}:README.md`], {
        cwd: root,
        encoding: 'buffer',
      })
      readmeText = readmeBuf.toString('utf8')
    } else {
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
      version = pkg.version
      readmeText = await readFile(path.join(root, 'README.md'), 'utf8')
    }
    process.stdout.write(renderGitcodeReadme(readmeText, version))
  } else {
    const outcome = await syncGitcodeBranch({
      cwd: root,
      remote: args.remote,
      sourceRef: args.source,
      targetBranch: args.branch,
      tag: args.tag,
      dryRun: args.dryRun,
    })
    if (outcome.dryRun) {
      console.log(
        `GitCode README 预览完成 (${outcome.targetBranch}): commit=${outcome.commit}, upToDate=${outcome.upToDate}, refspecs=${outcome.refspecs.join(', ') || '(无)'}`,
      )
    } else if (!outcome.pushed) {
      console.log(`GitCode ${outcome.targetBranch} 已是最新 (${outcome.commit.slice(0, 7)})，无需推送`)
    } else {
      console.log(`GitCode ${outcome.targetBranch} 同步完成: ${outcome.refspecs.join(', ')}`)
    }
  }
}
