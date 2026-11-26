import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { verifyReadmeDownloadLinks } from './render-release-notes.mjs'
import { renderGitcodeReadme, syncGitcodeBranch } from './sync-gitcode-readme.mjs'

const execFileAsync = promisify(execFile)
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const repoReadme = await readFile(new URL('../README.md', import.meta.url), 'utf8')

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return stdout.trim()
}

test('renderGitcodeReadme converts GitHub README to GitCode-only download links', () => {
  const converted = renderGitcodeReadme(repoReadme, pkg.version)
  verifyReadmeDownloadLinks(converted, pkg.version, { host: 'gitcode' })
  assert.doesNotMatch(converted, /https:\/\/github\.com\/Fy1ng\/Fy1Sync\/releases/)
  assert.ok(converted.includes('[Releases 页面](https://gitcode.com/Fy1ng/Fy1Sync/releases)'))
  assert.ok(converted.includes('直接点页面顶部的下载按钮即可, 也可以到 [Releases 页面](https://gitcode.com/Fy1ng/Fy1Sync/releases) 按系统选择安装包.'))
})

test('renderGitcodeReadme rejects README containing GitCode or Linux direct links', () => {
  const mixed = `${repoReadme}\nhttps://gitcode.com/Fy1ng/Fy1Sync/releases/download/v${pkg.version}/Fy1Sync-${pkg.version}-win-x64-nsis.exe`
  assert.throws(() => renderGitcodeReadme(mixed, pkg.version))

  const withLinux = `${repoReadme}\nhttps://github.com/Fy1ng/Fy1Sync/releases/download/v${pkg.version}/Fy1Sync-${pkg.version}-linux-x64.AppImage`
  assert.throws(() => renderGitcodeReadme(withLinux, pkg.version))
})

test('syncGitcodeBranch fast-forwards GitCode mirror with GitCode-only README across multiple updates and tags', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fy1sync-gitcode-sync-test-'))
  try {
    const originBare = path.join(tempRoot, 'origin.git')
    const gitcodeBare = path.join(tempRoot, 'gitcode.git')
    const workDir = path.join(tempRoot, 'work')

    await execFileAsync('git', ['init', '--bare', originBare])
    await execFileAsync('git', ['init', '--bare', gitcodeBare])
    await execFileAsync('git', ['init', '-b', 'main', workDir])
    await git(workDir, ['config', 'user.name', 'Test User'])
    await git(workDir, ['config', 'user.email', 'test@example.com'])
    await git(workDir, ['remote', 'add', 'origin', originBare])
    await git(workDir, ['remote', 'add', 'gitcode', gitcodeBare])

    // Initial shared commit C1
    await writeFile(path.join(workDir, 'package.json'), JSON.stringify({ name: 'fy1sync', version: pkg.version }, null, 2), 'utf8')
    await writeFile(path.join(workDir, 'README.md'), repoReadme, 'utf8')
    await git(workDir, ['add', 'package.json', 'README.md'])
    await git(workDir, ['commit', '-m', 'init'])
    await git(workDir, ['push', '-u', 'origin', 'main'])
    await git(workDir, ['push', 'gitcode', 'main'])

    // New commit C2 pushed to origin/main
    await writeFile(path.join(workDir, 'feature.txt'), 'v1\n', 'utf8')
    await git(workDir, ['add', 'feature.txt'])
    await git(workDir, ['commit', '-m', 'feat: add feature'])
    await git(workDir, ['push', 'origin', 'main'])
    const c2 = await git(workDir, ['rev-parse', 'HEAD'])

    const firstSync = await syncGitcodeBranch({ cwd: workDir, remote: 'gitcode', sourceRef: 'main', targetBranch: 'main' })
    assert.equal(firstSync.created, true)
    assert.equal(firstSync.upToDate, false)
    assert.equal(firstSync.pushed, true)
    assert.deepEqual(firstSync.parents, [c2])

    // origin/main retains GitHub-only README; gitcode/main has GitCode-only README
    const originReadme = await git(originBare, ['show', 'refs/heads/main:README.md'])
    const gitcodeReadme1 = await git(gitcodeBare, ['show', 'refs/heads/main:README.md'])
    verifyReadmeDownloadLinks(originReadme, pkg.version, { host: 'github' })
    verifyReadmeDownloadLinks(gitcodeReadme1, pkg.version, { host: 'gitcode' })
    assert.equal(await git(workDir, ['status', '--short']), '')

    // Idempotent second call when nothing changed
    const secondSync = await syncGitcodeBranch({ cwd: workDir, remote: 'gitcode', sourceRef: 'main', targetBranch: 'main' })
    assert.equal(secondSync.created, false)
    assert.equal(secondSync.upToDate, true)
    assert.equal(secondSync.pushed, false)

    // Commit C3 + release tag pushed after diverged gitcode mirror commit (two-parent fast-forward)
    await writeFile(path.join(workDir, 'feature.txt'), 'v2\n', 'utf8')
    await git(workDir, ['add', 'feature.txt'])
    await git(workDir, ['commit', '-m', 'release: tag v0.6.0'])
    await git(workDir, ['tag', 'v0.6.0'])
    await git(workDir, ['push', 'origin', 'main', 'v0.6.0'])
    const c3 = await git(workDir, ['rev-parse', 'HEAD'])

    const thirdSync = await syncGitcodeBranch({
      cwd: workDir,
      remote: 'gitcode',
      sourceRef: 'main',
      targetBranch: 'main',
      tag: 'v0.6.0',
    })
    assert.equal(thirdSync.created, true)
    assert.equal(thirdSync.upToDate, false)
    assert.equal(thirdSync.pushed, true)
    assert.deepEqual(thirdSync.parents, [firstSync.commit, c3])

    // Verify tag points to C3, C3 is ancestor of gitcode/main, and gitcode/main has updated files + GitCode README
    const gitcodeMainSha = await git(gitcodeBare, ['rev-parse', 'refs/heads/main'])
    const gitcodeTagSha = await git(gitcodeBare, ['rev-parse', 'refs/tags/v0.6.0^{commit}'])
    assert.equal(gitcodeTagSha, c3)
    await execFileAsync('git', ['merge-base', '--is-ancestor', c3, gitcodeMainSha], { cwd: gitcodeBare })
    assert.equal(await git(gitcodeBare, ['show', 'refs/heads/main:feature.txt']), 'v2')
    const gitcodeReadme2 = await git(gitcodeBare, ['show', 'refs/heads/main:README.md'])
    verifyReadmeDownloadLinks(gitcodeReadme2, pkg.version, { host: 'gitcode' })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
