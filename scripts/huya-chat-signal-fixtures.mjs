/** Redact local web WUP captures. Raw bytes and signatures are never printed. */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const loader = await createServer({ root, configFile: false, envFile: false, logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, watch: null } })
try {
  const { HuyaTarsReader: Reader, HuyaTarsWriter: Writer } = await loader.ssrLoadModule('/server/platforms/huyaWup.ts')
  const uid = 1024n
  const wsTime = '6553f100'
  const wsSecret = '0'.repeat(32)
  function fields(bytes, struct = false) {
    const reader = new Reader(bytes)
    const parse = () => {
      const result = []
      while (!reader.done) {
        const [tag, type] = reader.head()
        if (type === 11) { if (!struct) throw new Error('Unexpected struct end.'); return result }
        let value
        if (type <= 3 || type === 12) value = reader.int(type)
        else if (type === 6 || type === 7) value = reader.string(type)
        else if (type === 13) value = reader.bytes(type)
        else if (type === 8) {
          const count = reader.size(16)
          value = []
          for (let i = 0; i < count * 2; i++) {
            const [childTag, childType] = reader.head()
            value.push({ tag: childTag, type: childType, value: childType === 13 ? reader.bytes(childType)
              : childType === 6 || childType === 7 ? reader.string(childType) : reader.int(childType) })
          }
        } else if (type === 10) { struct = true; value = parse(); struct = false }
        else throw new Error('Unsupported capture field.')
        result.push({ tag, type, value })
      }
      return result
    }
    return parse()
  }
  function encode(items) {
    const writer = new Writer()
    const append = children => {
      for (const { tag, type, value } of children) {
        if (type <= 3 || type === 12) writer.int64(tag, value)
        else if (type === 6 || type === 7) writer.string(tag, value)
        else if (type === 13) writer.bytes(tag, value)
        else if (type === 8) { writer.head(tag, 8); writer.int(0, value.length / 2); append(value) }
        else if (type === 10) {
          writer.head(tag, 10)
          append(value)
          writer.head(0, 11)
        }
      }
    }
    append(items)
    return writer.finish()
  }
  async function redacted(name) {
    const bytes = await readFile(new URL(`../.runtime-cache/huya-h2-web/${name}`, import.meta.url))
    const packet = fields(bytes.subarray(4))
    packet.find(field => field.tag === 4).value = 1n
    const payload = packet.find(field => field.tag === 7)
    const map = fields(payload.value)
    for (const child of map[0].value.filter(field => field.type === 13)) {
      const body = fields(child.value)
      if (body[0]?.type === 10) {
        for (const field of body[0].value) {
          if (field.tag === 0) field.value = uid
          else if (field.tag === 1) field.value = `chat-${uid}`
          else if (field.tag === 3 && field.value.includes('wsSecret=')) field.value = `wsSecret=${wsSecret}&wsTime=${wsTime}`
        }
      }
      child.value = encode(body)
    }
    payload.value = encode(map)
    const body = encode(packet)
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(body.length + 4)
    return Buffer.concat([prefix, body]).toString('hex')
  }
  const fixture = {
    note: 'Reduced browser WUP captures. Presenter UID replaced with 1024, request ID with 1, wsSecret with 32 zeroes, wsTime with fixed synthetic issue time. No live signature remains.',
    presenterUid: String(uid), now: 1700000000000, ttlSeconds: 300,
    host: 'al-dm.p2p.huya.com', channel: '48', subChannel: '0', wsTime, wsSecret,
    request: await redacted('getP2PStreamInfo.req.bin'),
    response: await redacted('getP2PStreamInfo.rsp.bin'),
  }
  await writeFile(new URL('../server/platforms/fixtures/huya-chat-signal.json', import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`)
  console.log('Anonymous chat-signaling fixture regenerated with synthetic identifiers and signature.')
} catch {
  console.error('Chat-signaling fixture generation failed; no raw capture details were printed.')
  process.exitCode = 1
} finally { await loader.close() }
