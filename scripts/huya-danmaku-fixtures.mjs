/** Offline, schema-preserving anonymization of local Huya capture records. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const input = path.resolve(root, process.argv[2] || '.runtime-cache/huya-h2-claude')
const output = path.resolve(root, 'server/danmaku/fixtures/huya-real.json')
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

// The allowlist is deliberately narrow. Unknown strings and byte blobs never survive.
function anonymize(field) {
  const { type, value } = field
  if (type <= 3 || type === 12) return { ...field, value: type === 12 ? 0n : type === 0 ? 1n : type === 1 ? 42n : 12345n }
  if (type === 4 || type === 5) return { ...field, value: Buffer.alloc(type === 4 ? 4 : 8) }
  if (type === 6 || type === 7) return { ...field, value: value ? 'placeholder' : '' }
  if (type === 13) return { ...field, value: Buffer.alloc(0) }
  return { ...field, value: value.map(anonymize) }
}
function replace(fields, tag, value) {
  const field = fields.find(field => field.tag === tag)
  if (!field) throw Error('Missing fixture field')
  field.value = value
}
function body(uri, bytes) {
  let original
  try { original = parse(bytes) } catch { return Buffer.alloc(0) }
  const clean = original.map(anonymize)
  if (uri === 1400n) {
    replace(get(clean, 0), 2, 'viewer-placeholder')
    replace(clean, 3, 'sanitized chat')
  } else if ([6501n, 6502n, 6507n].includes(uri)) {
    replace(clean, 0, get(original, 0)); replace(clean, 2, get(original, 2))
    if (uri === 6501n) {
      replace(clean, 5, 'presenter-placeholder')
      replace(clean, 6, 'viewer-placeholder')
    }
    if (get(clean, 14) !== undefined) replace(clean, 14, 'https://example.invalid/avatar.png')
    if (get(clean, 20) !== undefined) replace(clean, 20, get(original, 20))
  } else if (uri === 8006n) replace(clean, 0, get(original, 0))
  return fields(clean)
}
function sanitize(original) {
  const command = get(original, 0)
  const clean = original.map(anonymize)
  replace(clean, 0, command)
  const payload = parse(get(original, 1)); const inner = payload.map(anonymize)
  if (command === 17n || command === 2n) {
    replace(inner, 0, get(payload, 0))
    if (command === 17n) replace(inner, 1, get(payload, 1).map(field => ({ ...field, value: /^live:/.test(field.value) ? 'live:12345' : 'chat:12345' })))
  } else if (command === 7n) {
    const uri = get(payload, 1)
    replace(inner, 1, uri); replace(inner, 2, body(uri, get(payload, 2)))
    // Preserve only the numeric transport enums, not message IDs or sender IDs.
    for (const tag of [0, 3, 4]) {
      const value = get(payload, tag)
      if (typeof value === 'bigint') replace(inner, tag, value)
      else if (typeof value === 'string' && /^(live|chat):\d+$/.test(value)) replace(inner, tag, value.startsWith('live:') ? 'live:12345' : 'chat:12345')
    }
  } else if (command === 22n) {
    replace(inner, 0, /^live:/.test(get(payload, 0)) ? 'live:12345' : 'chat:12345')
    replace(inner, 1, get(payload, 1).map(item => {
      const clean = anonymize(item); const uri = get(item.value, 0)
      replace(clean.value, 0, uri); replace(clean.value, 1, body(uri, get(item.value, 1)))
      return clean
    }))
  } else throw Error('Unexpected fixture command')
  replace(clean, 1, fields(inner))
  return clean
}
function pushes(original) {
  const command = get(original, 0); const payload = parse(get(original, 1))
  if (command === 7n) return [{ uri: get(payload, 1), bytes: get(payload, 2) }]
  if (command === 22n) return get(payload, 1).map(item => ({ uri: get(item.value, 0), bytes: get(item.value, 1) }))
  return []
}
function expected(clean) {
  const command = Number(get(clean, 0)); const messages = []; const viewers = []; const unknownUriCounts = {}
  for (const push of pushes(clean)) {
    if (![1400n, 6501n, 6502n, 6507n, 8006n].includes(push.uri)) { unknownUriCounts[String(push.uri)] = (unknownUriCounts[String(push.uri)] || 0) + 1; continue }
    const data = parse(push.bytes)
    if (push.uri === 1400n) messages.push({ username: get(get(data, 0), 2), text: get(data, 3), system: false })
    else if (push.uri === 8006n) viewers.push(Number(get(data, 0)))
    else {
      const id = String(get(data, 0)); const count = Number(get(data, 2)); const name = get(data, 20)
      messages.push({ username: push.uri === 6501n ? get(data, 6) : '匿名', text: name ? `赠送${name} x${count}` : `赠送礼物 ${id} x${count}`, system: true, huyaGift: { id, count, ...(name ? { name } : {}) } })
    }
  }
  return { command, registered: command === 17 && get(parse(get(clean, 1)), 0) === 0n, emptyFrame: false, malformed: false, messages, viewers, unknownUriCounts }
}

const allowedStrings = new Set(['', 'placeholder', 'viewer-placeholder', 'presenter-placeholder', 'sanitized chat',
  'https://example.invalid/avatar.png', 'live:12345', 'chat:12345', '虎粮', '超粉虎粮', '热火', '3倍亲密12'])
function verifyAnonymized(nodes) {
  for (const node of nodes) {
    if (typeof node.value === 'string' && !allowedStrings.has(node.value)) throw Error('Unapproved text remains in anonymized fixture')
    if (Array.isArray(node.value)) verifyAnonymized(node.value)
    if (node.type === 13 && node.value.length) verifyAnonymized(parse(node.value))
  }
}

const captures = []
const audit = []
for (const file of fs.readdirSync(input).filter(file => /^raw-(kpl|a16789|117736)-(userInfo|group)\.json$/.test(file)).sort()) {
  const records = JSON.parse(fs.readFileSync(path.join(input, file), 'utf8'))
  audit.push({ file, frames: records.length, nonempty: records.filter(record => record.hex).length, empty: records.filter(record => !record.hex).length, previouslyMalformed: records.filter(record => record.malformed).length })
  records.forEach((record, index) => {
    if (!record.hex) return
    const bytes = Buffer.from(record.hex, 'hex'); const original = parse(bytes)
    if (!fields(original).equals(bytes)) throw Error('Non-lossless capture round trip')
    captures.push({ file, index, original, command: get(original, 0), uris: pushes(original).map(push => push.uri) })
  })
}
const samples = []
function select(name, predicate) {
  const source = captures.find(predicate)
  if (!source) throw Error(`Missing fixture category: ${name}`)
  const clean = sanitize(source.original)
  const sample = { name, kind: 'real-anonymized', source: { file: source.file, index: source.index, capturedOn: '2026-10-27', durationSeconds: 120 }, hex: fields(clean).toString('hex'), expected: expected(clean) }
  samples.push(sample)
  return { sample, clean, source }
}
select('registeredGroup', frame => frame.command === 17n)
select('cmd7Chat', frame => frame.command === 7n && frame.uris.includes(1400n))
const chat = select('cmd22Chat', frame => frame.command === 22n && frame.uris.includes(1400n))
let gift
for (const id of [4n, 20699n, 20865n, 22003n]) {
  const chosen = select(`cmd7Gift${id}`, frame => frame.command === 7n && frame.uris.includes(6501n) && get(parse(pushes(frame.original)[0].bytes), 0) === id)
  gift ||= chosen
}
const viewers = select('cmd22Viewers', frame => frame.command === 22n && frame.uris.length === 1 && frame.uris.includes(8006n))
select('cmd22MixedViewersUnknown', frame => frame.command === 22n && frame.uris.length > 1 && frame.uris.includes(8006n))
select('cmd22UnknownDouble', frame => frame.command === 22n && frame.uris.length > 1 && frame.uris.every(uri => uri === 6111n))
select('cmd7UnknownOpaque', frame => frame.command === 7n && frame.uris.includes(3102n))
select('cmd22Unknown1300000', frame => frame.command === 22n && frame.uris.includes(1300000n))

// No captured batch contained a gift. This explicitly labelled derivative combines
// three independently captured, anonymized bodies into the observed V2 envelope.
const derivative = parse(Buffer.from(chat.sample.hex, 'hex'))
const batch = parse(get(derivative, 1)); const chatItem = get(batch, 1)[0]
const giftPayload = parse(get(gift.clean, 1))
const giftItem = { tag: 0, type: 10, value: [
  { tag: 0, type: 1, value: 6501n },
  { tag: 1, type: 13, value: get(giftPayload, 2) },
  { tag: 2, type: 3, value: 12345n },
] }
replace(batch, 1, [chatItem, giftItem, get(parse(get(viewers.clean, 1)), 1)[0]])
replace(derivative, 1, fields(batch))
samples.push({ name: 'derivedBatchChatGiftViewers', kind: 'derived-recombined', source: [chat.sample.source, gift.sample.source, viewers.sample.source], hex: fields(derivative).toString('hex'), expected: expected(derivative) })
const emptySource = audit.find(item => item.empty > 0)
const emptyRecords = JSON.parse(fs.readFileSync(path.join(input, emptySource.file), 'utf8'))
samples.push({ name: 'emptyBinaryFrame', kind: 'captured-empty-binary', source: { file: emptySource.file, index: emptyRecords.findIndex(record => !record.hex), capturedOn: '2026-10-27' }, hex: '', expected: { command: null, registered: false, emptyFrame: true, malformed: false, messages: [], viewers: [], unknownUriCounts: {} } })
for (const sample of samples) if (sample.hex) verifyAnonymized(parse(Buffer.from(sample.hex, 'hex')))
fs.writeFileSync(output, JSON.stringify({ formatVersion: 1, capturedOn: '2026-10-27', placeholderPresenterUid: '12345', audit, samples }, null, 2) + '\n')
console.log(JSON.stringify({ output: path.relative(root, output), samples: samples.length, captureAudit: audit }))
