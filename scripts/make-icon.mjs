/**
 * Convert the supplied artwork, without cropping or changing its background, into Windows
 * shell sizes. The in-app CSS title-bar mark deliberately remains independent.
 *
 *   node scripts/make-icon.mjs [--out <directory>]
 *
 * Electron's locked nativeImage decoder performs high-quality resizing in a windowless,
 * isolated helper. No extra imaging dependency, generated artwork, or user profile is used.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const source = fileURLToPath(new URL('../packaging/icon-source.png', import.meta.url))
const root = fileURLToPath(new URL('../', import.meta.url))
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pixelChunks(bytes) {
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error('图标源必须为 PNG.')
  const parts = [signature]
  let cursor = 8, ended = false
  while (cursor + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(cursor)
    if (cursor + size + 12 > bytes.length) throw new Error('PNG 数据不完整.')
    const type = bytes.toString('ascii', cursor + 4, cursor + 8)
    // Retain color-management and transparency chunks, but no textual/content credentials.
    if (['IHDR', 'IDAT', 'IEND', 'PLTE', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'iCCP'].includes(type)) {
      parts.push(bytes.subarray(cursor, cursor + size + 12))
    }
    cursor += size + 12
    if (type === 'IEND') { ended = true; break }
  }
  if (!ended || cursor !== bytes.length) throw new Error('PNG 数据不完整或存在尾随数据.')
  return Buffer.concat(parts)
}

async function render(destination) {
  const { app, nativeImage } = await import('electron')
  const profile = process.env.FY1SYNC_ICON_PROFILE
  if (!profile || !path.resolve(profile).startsWith(path.join(root, '.runtime-cache') + path.sep)) throw new Error('图标生成仅允许隔离的本地缓存目录.')
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  app.disableHardwareAcceleration()
  try {
    await app.whenReady()
    const original = nativeImage.createFromBuffer(pixelChunks(await readFile(source)))
    const dimensions = original.getSize()
    if (original.isEmpty() || dimensions.width !== dimensions.height || dimensions.width < 256 || dimensions.width > 4096) throw new Error('图标源必须为 256..4096 像素的正方形 PNG.')
    const images = sizes.map(size => pixelChunks(original.resize({ width: size, height: size, quality: 'best' }).toPNG()))
    const directory = Buffer.alloc(6 + 16 * images.length)
    directory.writeUInt16LE(1, 2)
    directory.writeUInt16LE(images.length, 4)
    let offset = directory.length
    images.forEach((image, index) => {
      const at = 6 + 16 * index, size = sizes[index]
      directory.writeUInt8(size === 256 ? 0 : size, at)
      directory.writeUInt8(size === 256 ? 0 : size, at + 1)
      directory.writeUInt16LE(1, at + 4)
      directory.writeUInt16LE(32, at + 6)
      directory.writeUInt32LE(image.length, at + 8)
      directory.writeUInt32LE(offset, at + 12)
      offset += image.length
    })
    await mkdir(destination, { recursive: true })
    await writeFile(path.join(destination, 'icon.ico'), Buffer.concat([directory, ...images]))
    await writeFile(path.join(destination, 'icon.png'), images.at(-1))
    console.log(`图标已生成: ${sizes.join(', ')} px ICO 和 256 px PNG. 原图 ${dimensions.width}x${dimensions.height}, 未裁切.`)
  } finally { app.quit() }
}

const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out')) throw new Error('用法: node scripts/make-icon.mjs [--out <directory>]')
const destination = args.length ? path.resolve(args[1]) : path.join(root, 'packaging')
if (process.versions.electron) {
  // Electron emits ready only after this entry module finishes evaluating.
  void render(destination).catch(error => { console.error(error.message); process.exit(1) })
} else {
  const require = createRequire(import.meta.url)
  const profile = path.join(root, '.runtime-cache', `icon-generation-${randomUUID()}`)
  await mkdir(profile, { recursive: true })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^STREAM_SYNC_|^ELECTRON_RUN_AS_NODE$|^NODE_OPTIONS$|^NODE_PATH$/i.test(key)))
  env.FY1SYNC_ICON_PROFILE = profile
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [fileURLToPath(import.meta.url), '--out', destination], {
      cwd: root, env, windowsHide: true, shell: false, stdio: ['ignore', 'inherit', 'inherit'],
    })
    const timer = setTimeout(() => { child.kill(); reject(new Error('图标生成超时.')) }, 45_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', value => { clearTimeout(timer); resolve(value ?? 1) })
  })
  if (code !== 0) throw new Error('图标生成失败.')
}
