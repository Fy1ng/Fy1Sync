/**
 * Render the macOS DMG installer background at 1x (540x436 @ 72 DPI) and 2x (1080x872 @ 144 DPI)
 * using Playwright's headless Chromium with deterministic PNG chunk normalization.
 *
 *   node scripts/make-dmg-background.mjs [--out <directory>]
 */

import { crc32 } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../', import.meta.url))
const logicalWidth = 540
const logicalHeight = 436
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function makeChunk(type, data) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 4, 'ascii')
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([header, data, checksum])
}

function normalizePng(bytes, pixelsPerMeter, expectedWidth, expectedHeight) {
  if (!bytes.subarray(0, 8).equals(pngSignature)) throw new Error('Expected PNG image buffer')
  if (bytes.readUInt32BE(16) !== expectedWidth || bytes.readUInt32BE(20) !== expectedHeight) {
    throw new Error('Unexpected rendered DMG background dimensions')
  }
  const physData = Buffer.alloc(9)
  physData.writeUInt32BE(pixelsPerMeter, 0)
  physData.writeUInt32BE(pixelsPerMeter, 4)
  physData.writeUInt8(1, 8)
  const physChunk = makeChunk('pHYs', physData)
  const chunks = [pngSignature]
  let cursor = 8, ended = false, insertedPhys = false
  while (cursor + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(cursor)
    if (cursor + size + 12 > bytes.length) throw new Error('Truncated PNG chunk')
    const type = bytes.toString('ascii', cursor + 4, cursor + 8)
    const raw = bytes.subarray(cursor, cursor + size + 12)
    if (type === 'IHDR') {
      chunks.push(raw, physChunk)
      insertedPhys = true
    } else if (['IDAT', 'IEND', 'PLTE', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'iCCP'].includes(type)) {
      chunks.push(raw)
    }
    cursor += size + 12
    if (type === 'IEND') { ended = true; break }
  }
  if (!ended || !insertedPhys || cursor !== bytes.length) throw new Error('Malformed PNG output')
  return Buffer.concat(chunks)
}

function buildMarkup() {
  // Light paper backdrop keeps Finder's mandatory dark icon labels legible in both Light and Dark Mode.
  // A 60px bottom margin avoids clipping from Finder's window title-bar height offset.
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${logicalWidth}px;
    height: ${logicalHeight}px;
    overflow: hidden;
    background: #f3f0ea;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  svg.stage {
    display: block;
    width: ${logicalWidth}px;
    height: ${logicalHeight}px;
  }
</style>
</head>
<body>
  <svg class="stage" viewBox="0 0 ${logicalWidth} ${logicalHeight}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${logicalWidth}" height="${logicalHeight}" fill="#f3f0ea"/>

    <!-- Drag-to-Applications arrow aligned with icon centers (140, 110) and (400, 110) -->
    <line x1="236" y1="110" x2="298" y2="110" stroke="#52525b" stroke-width="3" stroke-linecap="round" stroke-dasharray="6 6"/>
    <path d="M292 100 L304 110 L292 120" fill="none" stroke="#27272a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- First-launch guide card -->
    <defs>
      <clipPath id="card-clip">
        <rect x="30" y="202" width="480" height="174" rx="14"/>
      </clipPath>
    </defs>
    <rect x="30" y="202" width="480" height="174" rx="14" fill="#ffffff"/>
    <rect x="30" y="202" width="6" height="174" fill="#18181b" clip-path="url(#card-clip)"/>
    <rect x="30" y="202" width="480" height="174" rx="14" fill="none" stroke="#dcd8cf" stroke-width="1.5"/>

    <text x="50" y="231" font-size="14.5" font-weight="700" fill="#18181b">首次打开若提示「已损坏，无法打开」：</text>
    <text x="492" y="230" font-size="12" font-weight="500" fill="#71717a" text-anchor="end">仅首次需操作一次</text>

    <text x="50" y="259" font-size="13" font-weight="500" fill="#27272a">1. 先将上方 Fy1Sync 拖入右侧 Applications 文件夹</text>
    <text x="50" y="284" font-size="13" font-weight="500" fill="#27272a">2. 打开「终端 (Terminal)」，输入以下命令并按回车：</text>

    <rect x="50" y="297" width="442" height="40" rx="8" fill="#18181b" stroke="#2b2b30" stroke-width="1"/>
    <text x="271" y="322" font-family="SFMono-Regular, 'Cascadia Mono', Consolas, Menlo, monospace" font-size="14.5" font-weight="700" fill="#6fd3a8" text-anchor="middle">xattr -cr /Applications/Fy1Sync.app</text>

    <text x="50" y="359" font-size="12.5" font-weight="500" fill="#52525b">3. 再到「应用程序」中打开 Fy1Sync 即可正常使用</text>
  </svg>
</body>
</html>`
}

const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out')) {
  throw new Error('Usage: node scripts/make-dmg-background.mjs [--out <directory>]')
}
const destination = args.length ? path.resolve(args[1]) : path.join(root, 'packaging')
const markup = buildMarkup()

const browser = await chromium.launch({ headless: true })
try {
  const renderScale = async (scale, pixelsPerMeter) => {
    const context = await browser.newContext({
      viewport: { width: logicalWidth, height: logicalHeight },
      deviceScaleFactor: scale,
    })
    try {
      const page = await context.newPage()
      await page.setContent(markup, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts.ready)
      const raw = await page.screenshot({ type: 'png' })
      return normalizePng(raw, pixelsPerMeter, logicalWidth * scale, logicalHeight * scale)
    } finally {
      await context.close()
    }
  }
  // 2835 px/m = 72.009 DPI, 5670 px/m = 144.018 DPI (exact 2:1 ratio for macOS tiffutil -cathidpicheck).
  const [png1x, png2x] = await Promise.all([renderScale(1, 2835), renderScale(2, 5670)])
  await mkdir(destination, { recursive: true })
  await writeFile(path.join(destination, 'dmg-background.png'), png1x)
  await writeFile(path.join(destination, 'dmg-background@2x.png'), png2x)
  console.log(`Generated DMG backgrounds: ${logicalWidth}x${logicalHeight} (1x) and ${logicalWidth * 2}x${logicalHeight * 2} (2x).`)
} finally {
  await browser.close()
}
