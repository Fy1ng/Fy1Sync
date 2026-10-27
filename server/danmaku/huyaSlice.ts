import { inflateSync } from 'node:zlib'

// These limits apply independently of advertised packet/block/fragment sizes.
export const HUYA_SLICE_LIMITS = {
  packetBytes: 65_535, compressedBytes: 524_288, inflatedBytes: 1_048_576,
  fragments: 64, pendingMessages: 16, configEntries: 32, records: 512, fragmentLifetimeMs: 5_000,
} as const

export type HuyaSliceDiagnostics = {
  packets: number; blocks: number; messages: number; paddingPackets: number
  malformedPackets: number; malformedBlocks: number; inflateFailures: number; fragmentFailures: number
  fragmentMessages: number; sequenceGaps: number; sequenceDuplicates: number
  unhandledPackets: number; unhandledBlocks: number; bufferedBytes: number; pendingFragments: number
}
type Fragment = { count: number; codec: number; firstSeen: number; bytes: number; pieces: Map<number, Buffer> }
const PACKET_HEAD = 18
const BLOCK_HEAD = 15
const DATA_URI = 514_595
const PADDING_URI = 1_024_547
const MAX_BLOCK_BYTES = BLOCK_HEAD + 65_535 + 4 + HUYA_SLICE_LIMITS.configEntries * 5
const initial = (): HuyaSliceDiagnostics => ({ packets: 0, blocks: 0, messages: 0, paddingPackets: 0,
  malformedPackets: 0, malformedBlocks: 0, inflateFailures: 0, fragmentFailures: 0,
  fragmentMessages: 0, sequenceGaps: 0, sequenceDuplicates: 0, unhandledPackets: 0,
  unhandledBlocks: 0, bufferedBytes: 0, pendingFragments: 0 })

/** Incremental, bounded HTTP slice framing. No upstream bytes become errors or diagnostics. */
export class HuyaSliceParser {
  private readonly counts = initial()
  private readonly packet = Buffer.alloc(HUYA_SLICE_LIMITS.packetBytes)
  private packetLength = 0
  private expectedPacketLength = 0
  private blocks = Buffer.alloc(0)
  private readonly fragments = new Map<number, Fragment>()
  private fragmentBytes = 0
  private lastSequence: number | null = null

  constructor(private readonly onPush: (data: Uint8Array, sequence: number) => void,
    private readonly now: () => number = Date.now) {}

  get diagnostics(): Readonly<HuyaSliceDiagnostics> {
    return { ...this.counts, bufferedBytes: this.packetLength + this.blocks.length + this.fragmentBytes,
      pendingFragments: this.fragments.size }
  }

  /** Discard connection-local state; cumulative counters survive reconnects. */
  reset(): void {
    this.add('fragmentFailures', this.fragments.size)
    this.packetLength = 0
    this.expectedPacketLength = 0
    this.blocks = Buffer.alloc(0)
    this.fragments.clear()
    this.fragmentBytes = 0
    this.lastSequence = null
  }

  feed(chunk: Uint8Array): void {
    this.expireFragments()
    let offset = 0
    while (offset < chunk.length) {
      const target = this.expectedPacketLength || PACKET_HEAD
      const take = Math.min(target - this.packetLength, chunk.length - offset)
      this.packet.set(chunk.subarray(offset, offset + take), this.packetLength)
      this.packetLength += take
      offset += take
      if (this.packetLength < target) continue
      if (!this.expectedPacketLength) {
        const size = this.packet.readUInt16LE(8)
        if (size < PACKET_HEAD || this.packet.readUInt32LE(10) !== size - 10) {
          this.add('malformedPackets')
          // Keep a tiny header window while finding the next valid packet.
          this.packet.copyWithin(0, 1, PACKET_HEAD)
          this.packetLength = PACKET_HEAD - 1
          continue
        }
        this.expectedPacketLength = size
        if (size > this.packetLength) continue
      }
      this.add('packets')
      const uri = this.packet.readUInt32LE(14)
      if (uri === PADDING_URI) this.add('paddingPackets')
      else if (uri === DATA_URI) this.readBlocks(this.packet.subarray(PACKET_HEAD, this.packetLength))
      else this.add('unhandledPackets')
      this.packetLength = 0
      this.expectedPacketLength = 0
    }
  }

  private add(key: keyof HuyaSliceDiagnostics, value = 1): void {
    this.counts[key] = Math.min(Number.MAX_SAFE_INTEGER, this.counts[key] + value)
  }

  private readBlocks(data: Uint8Array): void {
    // One pending block and one packet are the maximum temporary concatenation.
    if (this.blocks.length + data.length > MAX_BLOCK_BYTES + HUYA_SLICE_LIMITS.packetBytes) {
      this.add('malformedBlocks')
      this.blocks = Buffer.alloc(0)
      return
    }
    const input = Buffer.concat([this.blocks, data])
    let offset = 0
    while (input.length - offset >= BLOCK_HEAD) {
      if (input[offset] !== 0xc8 || input[offset + 1] !== 0 || input[offset + 2] !== 3) {
        this.add('malformedBlocks')
        offset++
        continue
      }
      const payloadSize = input.readUInt16LE(offset + 13)
      const configOffset = offset + BLOCK_HEAD + payloadSize
      if (configOffset + 4 > input.length) break
      const configSize = input.readUInt32LE(configOffset)
      if (configSize > HUYA_SLICE_LIMITS.configEntries) {
        this.add('malformedBlocks')
        offset++
        continue
      }
      const end = configOffset + 4 + configSize * 5
      if (end > input.length) break
      this.add('blocks')
      const count = input.readUInt16LE(offset + 5)
      const sequence = input.readUInt32LE(offset + 7)
      const ordinal = input.readUInt16LE(offset + 3)
      const codec = input.readUInt16LE(offset + 11)
      const payload = input.subarray(offset + BLOCK_HEAD, configOffset)
      if (codec !== 48) this.add('unhandledBlocks')
      else if (count <= 1) this.decode(payload, sequence, count === 0)
      else this.appendFragment(sequence, ordinal, count, codec, payload)
      offset = end
    }
    this.blocks = Buffer.from(input.subarray(offset))
  }

  private appendFragment(sequence: number, ordinal: number, count: number, codec: number, payload: Buffer): void {
    if (count > HUYA_SLICE_LIMITS.fragments || payload.length === 0) {
      this.add('fragmentFailures')
      return
    }
    let frame = this.fragments.get(sequence)
    if (!frame) {
      if (this.fragments.size >= HUYA_SLICE_LIMITS.pendingMessages) this.dropFragment(this.fragments.keys().next().value!)
      frame = { count, codec, firstSeen: this.now(), bytes: 0, pieces: new Map() }
      this.fragments.set(sequence, frame)
    }
    if (frame.count !== count || frame.codec !== codec) {
      this.dropFragment(sequence)
      return
    }
    const previous = frame.pieces.get(ordinal)
    if (previous) {
      if (!previous.equals(payload)) this.dropFragment(sequence)
      return
    }
    if (frame.bytes + payload.length > HUYA_SLICE_LIMITS.compressedBytes
      || this.fragmentBytes + payload.length > HUYA_SLICE_LIMITS.compressedBytes) {
      this.dropFragment(sequence)
      return
    }
    frame.pieces.set(ordinal, Buffer.from(payload))
    frame.bytes += payload.length
    this.fragmentBytes += payload.length
    if (frame.pieces.size !== count) return
    this.fragments.delete(sequence)
    this.fragmentBytes -= frame.bytes
    // ComFrame in mainlib sorts the per-fragment sequence before concatenating.
    // Configuration bytes after each advertised payload must not be concatenated.
    const joined = Buffer.concat([...frame.pieces].sort(([a], [b]) => a - b).map(([, value]) => value), frame.bytes)
    if (this.decode(joined, sequence, false)) this.add('fragmentMessages')
    else this.add('fragmentFailures')
  }

  private decode(payload: Uint8Array, sequence: number, merged: boolean): boolean {
    let decoded: Buffer
    try {
      if (!payload.length || payload.length > HUYA_SLICE_LIMITS.compressedBytes) throw new Error()
      decoded = inflateSync(payload, { maxOutputLength: HUYA_SLICE_LIMITS.inflatedBytes })
    } catch {
      this.add('inflateFailures')
      return false
    }
    if (!merged) {
      if (!decoded.length) { this.add('malformedBlocks'); return false }
      this.deliver(decoded, sequence)
      return true
    }
    // Validate all record lengths before exposing any record from a merged block.
    const records: Array<{ begin: number; end: number; sequence: number }> = []
    let offset = 0
    while (offset < decoded.length) {
      if (offset + 8 > decoded.length || records.length >= HUYA_SLICE_LIMITS.records) {
        this.add('malformedBlocks'); return false
      }
      const length = decoded.readUInt32LE(offset)
      if (length <= 8 || length > decoded.length - offset) { this.add('malformedBlocks'); return false }
      records.push({ begin: offset + 8, end: offset + length, sequence: decoded.readUInt32LE(offset + 4) })
      offset += length
    }
    if (!records.length) { this.add('malformedBlocks'); return false }
    for (const record of records) this.deliver(decoded.subarray(record.begin, record.end), record.sequence)
    return true
  }

  private deliver(data: Uint8Array, rawSequence: number): void {
    const sequence = rawSequence & 0xffff
    if (this.lastSequence !== null) {
      const distance = (sequence - this.lastSequence + 65_536) & 0xffff
      if (distance === 0) this.add('sequenceDuplicates')
      else if (distance < 32_768) {
        this.add('sequenceGaps', distance - 1)
        this.lastSequence = sequence
      }
    } else this.lastSequence = sequence
    this.add('messages')
    try { this.onPush(data, sequence) } catch { /* Consumer failures do not escape the network parser. */ }
  }

  private dropFragment(sequence: number): void {
    const frame = this.fragments.get(sequence)
    if (!frame) return
    this.fragmentBytes -= frame.bytes
    this.fragments.delete(sequence)
    this.add('fragmentFailures')
  }

  private expireFragments(): void {
    const now = this.now()
    for (const [sequence, frame] of this.fragments) {
      if (now - frame.firstSeen >= HUYA_SLICE_LIMITS.fragmentLifetimeMs) this.dropFragment(sequence)
    }
  }
}
