import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const GITHUB_REPO = 'https://github.com/Fy1ng/Fy1Sync'
const GITCODE_REPO = 'https://gitcode.com/Fy1ng/Fy1Sync'

export function validateReleaseVersion(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid release version: ${String(version)}`)
  }
  return version
}

export function expectedReleasePackages(version) {
  validateReleaseVersion(version)
  return [
    `Fy1Sync-${version}-win-x64-nsis.exe`,
    `Fy1Sync-${version}-win-x64-portable.zip`,
    ...['x64', 'arm64'].flatMap(arch => ['dmg', 'zip'].map(ext => `Fy1Sync-${version}-mac-${arch}.${ext}`)),
    ...['x64', 'arm64'].flatMap(arch => ['deb', 'AppImage', 'tar.gz'].map(ext => `Fy1Sync-${version}-linux-${arch}.${ext}`)),
  ].sort()
}

export function releaseAssetUrls(version, filename) {
  validateReleaseVersion(version)
  return {
    github: `${GITHUB_REPO}/releases/download/v${version}/${filename}`,
    gitcode: `${GITCODE_REPO}/releases/download/v${version}/${filename}`,
  }
}

function badgeButton(label, message, color, href, alt) {
  const encodedLabel = encodeURIComponent(label).replaceAll('-', '--')
  const encodedMessage = encodeURIComponent(message).replaceAll('-', '--')
  const badge = `https://img.shields.io/badge/${encodedLabel}-${encodedMessage}-${color}?style=for-the-badge&labelColor=18181b`
  return `<a href="${href}"><img src="${badge}" alt="${alt}"></a>`
}

/**
 * Strip the duplicate top heading and legacy plain-text download table while keeping
 * every release-specific changelog item and platform/upgrade note intact.
 */
export function extractChangelogSections(rawNotes) {
  if (typeof rawNotes !== 'string' || !rawNotes.trim()) {
    throw new Error('Release notes source must not be empty')
  }
  const lines = rawNotes.replace(/\r\n/g, '\n').split('\n')
  const startIndex = lines[0]?.startsWith('# ') ? 1 : 0
  const sections = []
  let current = null
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      if (current) sections.push(current)
      current = { heading: line.slice(3).trim(), lines: [] }
    } else if (current) {
      current.lines.push(line)
    } else if (line.trim()) {
      current = { heading: '更新内容', lines: [line] }
    }
  }
  if (current) sections.push(current)

  const output = []
  for (const section of sections) {
    if (section.heading === '下载选择' || section.heading === '下载') {
      const notesOnly = section.lines.filter(line => {
        const trimmed = line.trim()
        if (!trimmed) return true
        if (trimmed.startsWith('|')) return false
        if (/^文件名均带有 `Fy1Sync-.*SHA256SUMS\.txt/.test(trimmed)) return false
        return true
      }).join('\n').trim()
      if (notesOnly) {
        output.push(`## 安装与升级说明\n\n${notesOnly}`)
      }
      continue
    }
    const body = section.lines.join('\n').trim()
    if (body) {
      output.push(`## ${section.heading}\n\n${body}`)
    }
  }
  if (output.length === 0) {
    throw new Error('Release notes must contain at least one non-empty section')
  }
  return output.join('\n\n')
}

export function renderReleaseNotes({ version, rawNotes }) {
  validateReleaseVersion(version)
  const link = suffix => releaseAssetUrls(version, `Fy1Sync-${version}-${suffix}`)
  const winExe = link('win-x64-nsis.exe')
  const winZip = link('win-x64-portable.zip')
  const macArmDmg = link('mac-arm64.dmg')
  const macArmZip = link('mac-arm64.zip')
  const macX64Dmg = link('mac-x64.dmg')
  const macX64Zip = link('mac-x64.zip')
  const linuxX64Deb = link('linux-x64.deb')
  const linuxX64AppImage = link('linux-x64.AppImage')
  const linuxX64Tar = link('linux-x64.tar.gz')
  const linuxArmDeb = link('linux-arm64.deb')
  const linuxArmAppImage = link('linux-arm64.AppImage')
  const linuxArmTar = link('linux-arm64.tar.gz')
  const sums = releaseAssetUrls(version, 'SHA256SUMS.txt')

  const buttons = [
    badgeButton('Windows 安装版', '.exe 直链下载', '6fd3a8', winExe.github, `下载 Windows x64 安装包 Fy1Sync-${version}-win-x64-nsis.exe`),
    badgeButton('Windows 国内下载', 'GitCode 镜像', '6fd3a8', winExe.gitcode, '从 GitCode 国内镜像下载 Windows 安装包'),
    badgeButton('Windows 免安装', '.zip 便携版', 'f3f0ea', winZip.github, `下载 Windows x64 便携包 Fy1Sync-${version}-win-x64-portable.zip`),
    badgeButton('macOS Apple 芯片', '.dmg 安装包', 'f3f0ea', macArmDmg.github, `下载 macOS arm64 安装包 Fy1Sync-${version}-mac-arm64.dmg`),
    badgeButton('macOS Intel', '.dmg 安装包', 'f3f0ea', macX64Dmg.github, `下载 macOS x64 安装包 Fy1Sync-${version}-mac-x64.dmg`),
    badgeButton('Linux x64', '.deb / .AppImage', 'f3f0ea', linuxX64Deb.github, `下载 Linux x64 安装包 Fy1Sync-${version}-linux-x64.deb`),
  ].join('\n  ')

  const changelog = extractChangelogSections(rawNotes)

  return `# Fy1Sync ${version}

## 立即下载

<p>
  ${buttons}
</p>

> GitHub 底部文件列表超过 10 项默认折叠了 Windows 安装包，请直接点击上方按钮或下表直链下载；国内访问 GitHub 较慢时请点 **国内下载**（若刚发布数分钟内镜像仍在同步，可前往 [GitCode 发布页](${GITCODE_REPO}/releases) 查看）。

| 系统 | 推荐安装包 | 免安装便携包 |
| --- | --- | --- |
| **Windows 10/11 (x64)** | **[win-x64-nsis.exe](${winExe.github})** · [国内下载](${winExe.gitcode}) | [win-x64-portable.zip](${winZip.github}) · [国内下载](${winZip.gitcode}) |
| **macOS 13+ (Apple 芯片)** | [mac-arm64.dmg](${macArmDmg.github}) · [国内下载](${macArmDmg.gitcode}) | [mac-arm64.zip](${macArmZip.github}) · [国内下载](${macArmZip.gitcode}) |
| **macOS 13+ (Intel)** | [mac-x64.dmg](${macX64Dmg.github}) · [国内下载](${macX64Dmg.gitcode}) | [mac-x64.zip](${macX64Zip.github}) · [国内下载](${macX64Zip.gitcode}) |
| **Linux (x64)** | [linux-x64.deb](${linuxX64Deb.github}) · [国内下载](${linuxX64Deb.gitcode}) | [AppImage](${linuxX64AppImage.github}) ([国内](${linuxX64AppImage.gitcode})) · [tar.gz](${linuxX64Tar.github}) ([国内](${linuxX64Tar.gitcode})) |
| **Linux (arm64)** | [linux-arm64.deb](${linuxArmDeb.github}) · [国内下载](${linuxArmDeb.gitcode}) | [AppImage](${linuxArmAppImage.github}) ([国内](${linuxArmAppImage.gitcode})) · [tar.gz](${linuxArmTar.github}) ([国内](${linuxArmTar.gitcode})) |

文件校验：[SHA256SUMS.txt](${sums.github}) · [国内下载](${sums.gitcode})

## 三步开始

1. **选画面**：国内免代理可直接粘贴 **虎牙 / 哔哩哔哩 / 斗鱼 / 抖音** 的官方比赛直播间；或点击 **CS2 赛程** 一键选择 **YouTube / Twitch** 官方直播（国内需开启系统代理）。
2. **选解说**：粘贴主播直播间链接，或输入数字房间号并点选平台。
3. **点自动对齐**：两路都播出画面后点击底栏 **自动对齐**（快捷键 \`A\`），微调用 **回退画面 / 回退解说**。

- **高画质或登录验证**：直播间画质受限或提示验证时，直接点击提示旁的 **登录** 按钮（或前往 \`设置 → 账号\`）。
- **YouTube 取流失败**：确认系统代理已开启，或点击报错旁的 **更新 yt-dlp** 按钮（也可在 \`设置 → 通用 → 取流工具\` 更新）。

${changelog}
`
}

export function verifyReadmeDownloadLinks(readmeText, version) {
  validateReleaseVersion(version)
  const required = [
    `${GITHUB_REPO}/releases/download/v${version}/Fy1Sync-${version}-win-x64-nsis.exe`,
    `${GITCODE_REPO}/releases/download/v${version}/Fy1Sync-${version}-win-x64-nsis.exe`,
    `${GITHUB_REPO}/releases/download/v${version}/Fy1Sync-${version}-win-x64-portable.zip`,
    `${GITHUB_REPO}/releases/download/v${version}/Fy1Sync-${version}-mac-arm64.dmg`,
    `${GITHUB_REPO}/releases/download/v${version}/Fy1Sync-${version}-mac-x64.dmg`,
    `${GITHUB_REPO}/releases/download/v${version}/Fy1Sync-${version}-linux-x64.deb`,
    `${GITHUB_REPO}/releases/download/v${version}/Fy1Sync-${version}-linux-x64.AppImage`,
  ]
  for (const url of required) {
    if (!readmeText.includes(url)) {
      throw new Error(`README.md is missing current v${version} direct download link: ${url}`)
    }
  }
}

function parseCliArgs(argv) {
  const options = { version: undefined, notes: undefined, out: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--version') options.version = argv[++i]
    else if (arg === '--notes') options.notes = argv[++i]
    else if (arg === '--out') options.out = argv[++i]
    else throw new Error(`Unsupported argument: ${arg}`)
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseCliArgs(process.argv.slice(2))
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const version = validateReleaseVersion(args.version ?? pkg.version)
  const notesPath = path.resolve(root, args.notes ?? path.join('packaging', 'releases', `${version}.md`))
  const rawNotes = await readFile(notesPath, 'utf8')
  const rendered = renderReleaseNotes({ version, rawNotes })
  if (args.out) {
    const outPath = path.resolve(root, args.out)
    await mkdir(path.dirname(outPath), { recursive: true })
    await writeFile(outPath, rendered, 'utf8')
    console.log(`已生成 ${version} 发布说明: ${outPath}`)
  } else {
    process.stdout.write(rendered)
  }
}
