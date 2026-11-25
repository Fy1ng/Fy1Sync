import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { expectedReleasePackages, extractChangelogSections, renderReleaseNotes, validateReleaseVersion, verifyReadmeDownloadLinks } from './render-release-notes.mjs'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const release051 = await readFile(new URL('../packaging/releases/0.5.1.md', import.meta.url), 'utf8')

test('renderReleaseNotes places clickable multi-platform download links and onboarding guide above changelog', () => {
  const output = renderReleaseNotes({ version: '0.5.1', rawNotes: release051 })
  const downloadHeading = output.indexOf('## 立即下载')
  const onboardingHeading = output.indexOf('## 三步开始')
  const changelogHeading = output.indexOf('## 更新内容')
  assert.ok(downloadHeading > 0)
  assert.ok(onboardingHeading > downloadHeading)
  assert.ok(changelogHeading > onboardingHeading)

  for (const filename of [...expectedReleasePackages('0.5.1'), 'SHA256SUMS.txt']) {
    assert.ok(output.includes(`https://github.com/Fy1ng/Fy1Sync/releases/download/v0.5.1/${filename}`), `missing GitHub link for ${filename}`)
    assert.ok(output.includes(`https://gitcode.com/Fy1ng/Fy1Sync/releases/download/v0.5.1/${filename}`), `missing GitCode link for ${filename}`)
  }

  // Legacy plain-text download table must be stripped while upgrade notes remain preserved.
  assert.ok(!output.includes('| 系统 | 架构 | 安装包 | 便携包 |'))
  assert.ok(output.includes('xattr -cr /Applications/Fy1Sync.app'))
  assert.ok(output.includes('Windows NSIS 支持覆盖升级并保留用户数据'))
})

test('validateReleaseVersion rejects malformed or unsafe versions', () => {
  assert.equal(validateReleaseVersion('0.5.1'), '0.5.1')
  assert.equal(validateReleaseVersion('1.0.0-rc.1'), '1.0.0-rc.1')
  for (const invalid of ['', 'v0.5.1', '../0.5.1', '0.5', '0.5.1/evil', '0.5.1\n', null, 123]) {
    assert.throws(() => validateReleaseVersion(invalid))
  }
})

test('extractChangelogSections rejects blank notes', () => {
  assert.throws(() => extractChangelogSections('   \n  '))
})

test('README.md keeps direct download buttons aligned with package.json version', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  verifyReadmeDownloadLinks(readme, pkg.version)
})
