/** Offline schema-preserving anonymization. Never prints capture contents or identity fields. */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const input = path.resolve(root, process.argv[2] || '.runtime-cache/huya-h2-web')
const output = path.join(root, 'server/danmaku/fixtures/huya-slice-real.json')
const MAX_BYTES = 1_048_576

class Reader {
  constructor(bytes) { this.bytes = bytes; this.position = 0; this.nodes = 0 }
  take(count) {
    if (!Number.isSafeInteger(count) || count < 0 || this.position + count > this.bytes.length) throw Error('Invalid capture structure')
    const bytes = this.bytes.subarray(this.position, this.position + count)
    this.position += count
    return bytes
  }
  head() { const byte = this.take(1)[0]; return { tag: byte >> 4 === 15 ? this.take(1)[0] : byte >> 4, type: byte & 15 } }
  int(type) {
    if (type === 12) return 0n
    if (type < 0 || type > 3) throw Error('Invalid capture integer')
    const bytes = this.take(2 ** type)
    return type === 3 ? bytes.readBigInt64BE() : BigInt(bytes.readIntBE(0, bytes.length))
  }
  size() {
    const head = this.head(); const value = this.int(head.type)
    if (head.tag !== 0 || value < 0n || value > BigInt(MAX_BYTES)) throw Error('Invalid capture length')
    return Number(value)
  }
  node(head, depth) {
    if (++this.nodes > 65536 || depth > 32) throw Error('Capture structure budget exceeded')
    let value
    if (head.type <= 3 || head.type === 12) value = this.int(head.type)
    else if (head.type === 4 || head.type === 5) value = Buffer.from(this.take(head.type === 4 ? 4 : 8))
    else if (head.type === 6 || head.type === 7) value = this.take(head.type === 6 ? this.take(1)[0] : this.take(4).readUInt32BE()).toString('utf8')
    else if (head.type === 13) {
      const subtype = this.head()
      if (subtype.tag !== 0 || subtype.type !== 0) throw Error('Invalid capture bytes')
      value = Buffer.from(this.take(this.size()))
    } else if (head.type === 10) value = this.fields(true, depth + 1)
    else if (head.type === 8 || head.type === 9) {
      const count = this.size() * (head.type === 8 ? 2 : 1)
      if (count > 8192) throw Error('Capture collection budget exceeded')
      value = Array.from({ length: count }, () => this.node(this.head(), depth + 1))
    } else throw Error('Invalid capture field')
    return { ...head, value }
  }
  fields(nested = false, depth = 0) {
    const fields = []
    while (this.position < this.bytes.length) {
      const head = this.head()
      if (head.type === 11) {
        if (nested) return fields
        throw Error('Invalid capture terminator')
      }
      fields.push(this.node(head, depth))
    }
    if (nested) throw Error('Incomplete capture structure')
    return fields
  }
}

const parse = bytes => new Reader(bytes).fields()
const get = (fields, tag) => fields.find(field => field.tag === tag)?.value
const head = (tag, type) => Buffer.from(tag < 15 ? [(tag << 4) | type] : [0xf0 | type, tag])
function integer(tag, value) {
  const type = value === 0n ? 12 : value >= -128n && value <= 127n ? 0 : value >= -32768n && value <= 32767n ? 1 : value >= -2147483648n && value <= 2147483647n ? 2 : 3
  return node({ tag, type, value })
}
function fields(value) { return Buffer.concat(value.map(node)) }
function node({ tag, type, value }) {
  const prefix = head(tag, type)
  if (type === 12) return prefix
  if (type <= 3) {
    const bytes = Buffer.alloc(2 ** type)
    if (type === 3) bytes.writeBigInt64BE(value)
    else bytes.writeIntBE(Number(value), 0, bytes.length)
    return Buffer.concat([prefix, bytes])
  }
  if (type === 4 || type === 5) return Buffer.concat([prefix, value])
  if (type === 6 || type === 7) {
    const bytes = Buffer.from(value, 'utf8'); const size = Buffer.alloc(type === 6 ? 1 : 4)
    if (type === 6) size.writeUInt8(bytes.length)
    else size.writeUInt32BE(bytes.length)
    return Buffer.concat([prefix, size, bytes])
  }
  if (type === 13) return Buffer.concat([prefix, head(0, 0), integer(0, BigInt(value.length)), value])
  if (type === 10) return Buffer.concat([prefix, fields(value), head(0, 11)])
  if (type === 8 || type === 9) return Buffer.concat([prefix, integer(0, BigInt(value.length / (type === 8 ? 2 : 1))), fields(value)])
  throw Error('Unsupported output field')
}


function anonymize(field) {
  const { type, value } = field
  if (type <= 3 || type === 12) return { ...field, value: type === 12 ? 0n : type === 0 ? 1n : type === 1 ? 42n : 12345n }
  if (type === 4 || type === 5) return { ...field, value: Buffer.alloc(type === 4 ? 4 : 8) }
  if (type === 6 || type === 7) return { ...field, value: value ? 'placeholder' : '' }
  if (type === 13) return { ...field, value: Buffer.alloc(0) }
  return { ...field, value: value.map(anonymize) }
}
function replace(data, tag, value, type) {
  const field = data.find(item => item.tag === tag)
  if (!field) throw Error('Missing capture field')
  field.value = value
  if (type !== undefined) field.type = type
}
const allowedStrings = new Set(['', 'placeholder', 'viewer-placeholder', 'presenter-placeholder', 'sanitized chat',
  'gift-placeholder', 'chat:12345', 'https://example.invalid/avatar.png'])
let identityCandidates = new Set()
let sanitizedCount = 0
function collectOriginal(data) {
  for (const field of data) {
    if (typeof field.value === 'string' && field.value.length >= 4) identityCandidates.add(field.value)
    else if (typeof field.value === 'bigint' && field.value > 65535n) identityCandidates.add(String(field.value))
    else if (Array.isArray(field.value)) collectOriginal(field.value)
  }
}
function verifyClean(data) {
  for (const field of data) {
    if (typeof field.value === 'string' && !allowedStrings.has(field.value)) throw Error('Unapproved text in sanitized fixture')
    else if (Array.isArray(field.value)) verifyClean(field.value)
    else if (field.type === 13 && field.value.length) verifyClean(parse(field.value))
  }
}
function crossCheckIdentity(data) {
  for (const field of data) {
    if (typeof field.value === 'string' && identityCandidates.has(field.value) && !allowedStrings.has(field.value)) throw Error('Original text remains in sanitized tree')
    else if (typeof field.value === 'bigint' && field.value > 65535n && identityCandidates.has(String(field.value))) throw Error('Original integer identity remains in sanitized tree')
    else if (Array.isArray(field.value)) crossCheckIdentity(field.value)
    else if (field.type === 13 && field.value.length) crossCheckIdentity(parse(field.value))
  }
}
function sanitizePush(bytes, index) {
  const original = parse(bytes)
  collectOriginal(original)
  const uri = get(original, 1)
  const originalBody = parse(get(original, 2))
  collectOriginal(originalBody)
  const cleanBody = originalBody.map(anonymize)
  if (uri === 1400n) {
    replace(get(cleanBody, 0), 2, 'viewer-placeholder')
    replace(cleanBody, 3, 'sanitized chat')
  } else if ([6501n, 6502n, 6507n].includes(uri)) {
    replace(cleanBody, 0, get(originalBody, 0))
    replace(cleanBody, 2, get(originalBody, 2))
    if (uri === 6501n) {
      replace(cleanBody, 5, 'presenter-placeholder')
      replace(cleanBody, 6, 'viewer-placeholder')
    }
    if (get(cleanBody, 14) !== undefined) replace(cleanBody, 14, 'https://example.invalid/avatar.png')
    if (get(cleanBody, 20) !== undefined) replace(cleanBody, 20, 'gift-placeholder')
  } else if (uri === 8006n) replace(cleanBody, 0, 12345n)
  const clean = original.map(anonymize)
  replace(clean, 0, get(original, 0))
  replace(clean, 1, uri)
  replace(clean, 2, fields(cleanBody))
  for (const tag of [3, 6]) if (typeof get(original, tag) === 'bigint') replace(clean, tag, get(original, tag))
  if (typeof get(original, 4) === 'string') replace(clean, 4, 'chat:12345')
  replace(clean, 5, 700000000000000000n + BigInt(index), 3)
  verifyClean(clean)
  crossCheckIdentity(clean)
  sanitizedCount++
  return clean
}
function packet(payload, uri = 514595, index = 1) {
  const out = Buffer.alloc(18 + payload.length)
  out.writeUInt32LE(index, 0)
  out.writeUInt32LE(1, 4)
  out.writeUInt16LE(out.length, 8)
  out.writeUInt32LE(out.length - 10, 10)
  out.writeUInt32LE(uri, 14)
  payload.copy(out, 18)
  return out
}
function block(payload, count, sequence, ordinal = 4000) {
  const header = Buffer.alloc(15)
  header.set([200, 0, 3])
  header.writeUInt16LE(ordinal, 3)
  header.writeUInt16LE(count, 5)
  header.writeUInt32LE(sequence, 7)
  header.writeUInt16LE(48, 11)
  header.writeUInt16LE(payload.length, 13)
  // Preserve the observed three-entry config layout, replacing timestamps with constants.
  const config = Buffer.alloc(19)
  config.writeUInt32LE(3)
  for (const [position, key] of [3, 14, 15].entries()) {
    config.writeUInt8(key, 4 + position * 5)
    config.writeUInt32LE(1, 5 + position * 5)
  }
  return Buffer.concat([header, payload, config])
}
const bytes = fs.readFileSync(path.join(input, 'slice-5.bin'))
const captured = []
let paddingSource
for (let offset = 0, packetIndex = 0; offset + 18 <= bytes.length; packetIndex++) {
  const length = bytes.readUInt16LE(offset + 8)
  if (length < 18 || offset + length > bytes.length) throw Error('Invalid capture packet')
  const uri = bytes.readUInt32LE(offset + 14)
  if (uri === 1024547 && !paddingSource) paddingSource = { packetIndex, offset }
  else if (uri === 514595) {
    const data = bytes.subarray(offset + 18, offset + length)
    if (data[0] !== 200 || data[1] !== 0 || data[2] !== 3) throw Error('Unexpected capture block')
    const size = data.readUInt16LE(13)
    const configOffset = 15 + size
    if (configOffset + 4 + data.readUInt32LE(configOffset) * 5 !== data.length) throw Error('Unexpected capture block boundary')
    captured.push({ packetIndex, offset, count: data.readUInt16LE(5), sequence: data.readUInt32LE(7),
      ordinal: data.readUInt16LE(3), payload: data.subarray(15, configOffset) })
  }
  offset += length
}
let counter = 1
const samples = []
function source(blocks) {
  return { file: 'slice-5.bin', packetIndices: blocks.map(value => value.packetIndex), capturedOn: '2026-10-27', room: 'a16789' }
}
function expected(pushes) {
  return pushes.map(value => {
    const uri = get(value, 1)
    const body = parse(get(value, 2))
    return { uri: String(uri), messageId: String(get(value, 5)),
      ...(uri === 1400n ? { username: get(get(body, 0), 2), text: get(body, 3) } : {}),
      ...(uri === 6501n ? { username: get(body, 6), presenter: get(body, 5), giftId: String(get(body, 0)),
        count: Number(get(body, 2)), name: get(body, 20) } : {}) }
  })
}
for (const [name, uri] of [['singleChat', 1400n], ['singleGift', 6501n]]) {
  const original = captured.find(value => value.count === 1 && get(parse(zlib.inflateSync(value.payload)), 1) === uri)
  if (!original) throw Error('Missing single capture category')
  const clean = sanitizePush(zlib.inflateSync(original.payload), counter++)
  const stream = packet(block(zlib.deflateSync(fields(clean)), 1, 100 + samples.length))
  samples.push({ name, kind: 'real-anonymized-reencoded', source: source([original]), hex: stream.toString('hex'), expected: expected([clean]) })
}
const mergedOriginal = captured.find(value => value.count === 0 && get(parse(zlib.inflateSync(value.payload).subarray(8, zlib.inflateSync(value.payload).readUInt32LE(0))), 1) === 6501n)
const mergedDecoded = zlib.inflateSync(mergedOriginal.payload)
const mergedClean = []
const records = []
for (let offset = 0; offset < mergedDecoded.length;) {
  const length = mergedDecoded.readUInt32LE(offset)
  if (length <= 8 || offset + length > mergedDecoded.length) throw Error('Invalid merged capture')
  const clean = sanitizePush(mergedDecoded.subarray(offset + 8, offset + length), counter++)
  mergedClean.push(clean)
  const message = fields(clean)
  const head = Buffer.alloc(8)
  head.writeUInt32LE(message.length + 8)
  head.writeUInt32LE(200 + records.length, 4)
  records.push(Buffer.concat([head, message]))
  offset += length
}
const mergedStream = packet(block(zlib.deflateSync(Buffer.concat(records)), 0, 0))
samples.push({ name: 'merged', kind: 'real-anonymized-reencoded', source: source([mergedOriginal]),
  hex: mergedStream.toString('hex'), expected: expected(mergedClean) })
const firstFragment = captured.find(value => value.count > 1)
const fragments = captured.filter(value => value.sequence === firstFragment.sequence).sort((a, b) => a.ordinal - b.ordinal)
if (fragments.length !== firstFragment.count) throw Error('Incomplete fragment capture')
const fragmentOriginal = zlib.inflateSync(Buffer.concat(fragments.map(value => value.payload)))
const fragmentClean = sanitizePush(fragmentOriginal, counter++)
const compressed = zlib.deflateSync(fields(fragmentClean))
const fragmentPackets = []
for (let index = 0; index < fragments.length; index++) {
  const begin = Math.floor(index * compressed.length / fragments.length)
  const end = Math.floor((index + 1) * compressed.length / fragments.length)
  fragmentPackets.push(packet(block(compressed.subarray(begin, end), fragments.length, 300, fragments[index].ordinal), 514595, index + 1))
}
samples.push({ name: 'fragmented', kind: 'real-anonymized-reencoded', source: source(fragments),
  hex: Buffer.concat(fragmentPackets).toString('hex'), expected: expected([fragmentClean]), fragmentCount: fragments.length })
const padding = Buffer.alloc(904, 255)
padding.set([200, 0, 132, 3])
samples.push({ name: 'padding', kind: 'real-anonymized-reencoded', source: { file: 'slice-5.bin', packetIndices: [paddingSource.packetIndex], capturedOn: '2026-10-27', room: 'a16789' },
  hex: packet(padding, 1024547).toString('hex'), expected: [] })
// A sanitized real single block deliberately spans two transport packet boundaries.
const acrossBlock = block(zlib.deflateSync(fields(sanitizePush(zlib.inflateSync(captured.find(value => value.count === 1 && get(parse(zlib.inflateSync(value.payload)), 1) === 1400n).payload), counter++))), 1, 400)
const splits = [7, 23]
const acrossPackets = [packet(acrossBlock.subarray(0, splits[0])), packet(acrossBlock.subarray(splits[0], splits[1])), packet(acrossBlock.subarray(splits[1]))]
const acrossClean = parse(zlib.inflateSync(acrossBlock.subarray(15, 15 + acrossBlock.readUInt16LE(13))))
samples.push({ name: 'crossPacketBlock', kind: 'real-anonymized-repacketized', source: source([captured.find(value => value.count === 1 && get(parse(zlib.inflateSync(value.payload)), 1) === 1400n)]),
  hex: Buffer.concat(acrossPackets).toString('hex'), expected: expected([acrossClean]) })
const json = JSON.stringify({ version: 1, samples }, null, 2) + '\n'
let matches = 0
for (const sample of samples) {
  const data = Buffer.from(sample.hex, 'hex')
  for (const candidate of identityCandidates) {
    if (candidate.length >= 6 && data.includes(Buffer.from(candidate))) matches++
  }
}
if (matches) throw Error('Original identity candidate remains in sanitized transport')
fs.writeFileSync(output, json)
console.log(JSON.stringify({ samples: samples.length, sanitizedPushes: sanitizedCount, privacyCandidateCount: identityCandidates.size, remainingIdentityMatches: matches }))
