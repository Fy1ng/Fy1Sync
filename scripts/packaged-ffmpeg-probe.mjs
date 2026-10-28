import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { deflateSync } from 'node:zlib'

function der(tag, bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.concat(bytes)
  let length = body.length
  const encoded = []
  do { encoded.unshift(length & 255); length >>>= 8 } while (length)
  return Buffer.concat([Buffer.from([tag, ...(body.length < 128 ? [body.length] : [128 | encoded.length, ...encoded])]), body])
}

function selfSignedCertificate() {
  // Generate a throwaway identity without OpenSSL, a certificate store or a saved private key.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const algorithm = Buffer.from('300d06092a864886f70d01010b0500', 'hex')
  const name = der(0x30, [der(0x31, [der(0x30, [Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from('localhost'))])])])
  const time = date => der(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'))
  const validity = der(0x30, [time(new Date(Date.now() - 86400_000)), time(new Date(Date.now() + 86400_000))])
  const serial = randomBytes(16); serial[0] &= 0x7f; serial[0] |= 1
  const san = der(0xa3, [der(0x30, [der(0x30, [Buffer.from('0603551d11', 'hex'), der(0x04, der(0x30, [der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1]))]))])])])
  const tbs = der(0x30, [der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), algorithm, name, validity, name, publicKey.export({ format: 'der', type: 'spki' }), san])
  const certificate = der(0x30, [tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), sign('RSA-SHA256', tbs, privateKey)]))])
  const cert = '-----BEGIN CERTIFICATE-----\n' + certificate.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n'
  return { key: privateKey.export({ format: 'pem', type: 'pkcs8' }), cert }
}

function png(color) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4)
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, body, checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(32); header.writeUInt32BE(18, 4); header[8] = 8; header[9] = 2
  const pixels = Buffer.alloc(18 * (1 + 32 * 3))
  for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) for (let c = 0; c < 3; c++) pixels[y * 97 + 1 + x * 3 + c] = color[c]
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

function gifFacts(data) {
  assert.equal(data.subarray(0, 6).toString(), 'GIF89a')
  assert.equal(data.readUInt16LE(6), 320); assert.equal(data.readUInt16LE(8), 180)
  let offset = 13 + ((data[10] & 0x80) ? 3 * (1 << ((data[10] & 7) + 1)) : 0), frames = 0
  function blocks() {
    while (true) {
      assert(offset < data.length, 'Truncated GIF sub-block')
      const size = data[offset++]; if (!size) return
      offset += size; assert(offset <= data.length, 'GIF sub-block extends past EOF')
    }
  }
  while (offset < data.length) {
    const marker = data[offset++]
    if (marker === 0x3b) { assert.equal(offset, data.length); break }
    if (marker === 0x21) { offset++; blocks(); continue }
    assert.equal(marker, 0x2c, 'Unexpected GIF block'); assert(offset + 9 < data.length)
    const flags = data[offset + 8]; offset += 9
    if (flags & 0x80) offset += 3 * (1 << ((flags & 7) + 1))
    offset++; blocks(); frames++
  }
  assert.equal(data[data.length - 1], 0x3b, 'Missing GIF trailer'); assert.equal(frames, 2)
  return { magic: 'GIF89a', width: 320, height: 180, frames, size: data.length }
}

function execute(exe, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false, overflow = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 30_000)
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 128_000) { overflow = true; child.kill() } })
    child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 128_000) { overflow = true; child.kill() } })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ args, code, signal, timedOut, overflow, stdout, stderr }) })
  })
}

function completed(result) {
  assert(!result.timedOut, 'FFmpeg process timed out'); assert(!result.overflow, 'FFmpeg output limit exceeded'); assert.equal(result.signal, null)
}

export async function probePackagedFfmpeg({ ffmpeg, directory, env }) {
  await mkdir(directory)
  const isolatedEnv = {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:https?_proxy|all_proxy|no_proxy|appdata|localappdata|userprofile|home|temp|tmp)$/i.test(key))),
    APPDATA: directory, LOCALAPPDATA: directory, USERPROFILE: directory, TEMP: directory, TMP: directory,
    http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '',
  }
  const help = await execute(ffmpeg, ['-hide_banner', '-h', 'protocol=tls'], isolatedEnv, directory)
  completed(help); assert.equal(help.code, 0, help.stderr)
  assert.match(help.stdout, /^\s*-tls_verify\s+[^\n]+\(default true\)/m)
  await writeFile(path.join(directory, 'frame-01.png'), png([255, 0, 0]))
  await writeFile(path.join(directory, 'frame-02.png'), png([0, 0, 255]))
  const output = path.join(directory, 'result.gif')
  const gif = await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-framerate', '5', '-start_number', '1', '-i', path.join(directory, 'frame-%02d.png'), '-filter_complex', '[0:v]scale=320:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer', '-loop', '0', output], isolatedEnv, directory)
  completed(gif); assert.equal(gif.code, 0, gif.stderr)
  const facts = gifFacts(await readFile(output))
  const sockets = new Set(), tlsErrors = []; let requests = 0
  const server = https.createServer(selfSignedCertificate(), (_request, response) => { requests++; response.writeHead(200).end('unexpected trusted request') })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('tlsClientError', error => tlsErrors.push(error.message))
  let tls
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const url = `https://127.0.0.1:${server.address().port}/self-signed.mp4`
    // Deliberately omit tls_verify to exercise the shipped default.
    tls = await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-rw_timeout', '10000000', '-i', url, '-c', 'copy', path.join(directory, 'untrusted.mp4')], isolatedEnv, directory)
    for (let attempt = 0; attempt < 20 && !tlsErrors.length; attempt++) await new Promise(resolve => setTimeout(resolve, 25))
    completed(tls); assert.notEqual(tls.code, 0, 'Untrusted TLS input must fail')
    assert.match(tls.stderr, /certificate|0x80090325|0x80090322|SNI or certificate check failed/i)
    assert(tlsErrors.length > 0, 'HTTPS server did not observe a failed TLS handshake')
    assert.equal(requests, 0, 'Untrusted HTTPS received an HTTP request')
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
  const result = { tlsVerifyDefault: true, gif: facts, tlsNegative: { ...tls, serverTlsErrors: tlsErrors, httpsRequests: requests }, checks: { tlsHelp: help, pngGif: gif } }
  await writeFile(path.join(directory, 'ffmpeg-probe.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}
