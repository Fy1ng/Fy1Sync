/**
 * Bit-packed base64 codec for binary (0/255) template bitmaps.
 *
 * A 32x48 template is 1536 pixels. Stored one byte per pixel it costs 1.5 KB of
 * JSON per sample; bit-packed it is 192 bytes -> 256 base64 characters. Profiles
 * carry dozens of samples and travel through localStorage, IndexedDB and the
 * preset files on disk, so the packed form is what gets persisted.
 *
 * The base64 alphabet is implemented here rather than via `atob`/`btoa` so the
 * exact same code runs in the window, in a worker and in Node without depending
 * on which globals a given environment exposes.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Int16Array(128).fill(-1)
for (let index = 0; index < ALPHABET.length; index += 1) {
  LOOKUP[ALPHABET.charCodeAt(index)] = index
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const full = bytes.length - (bytes.length % 3)
  for (let index = 0; index < full; index += 3) {
    const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0)
    out +=
      ALPHABET[(chunk >> 18) & 63]! +
      ALPHABET[(chunk >> 12) & 63]! +
      ALPHABET[(chunk >> 6) & 63]! +
      ALPHABET[chunk & 63]!
  }
  const remaining = bytes.length - full
  if (remaining === 1) {
    const chunk = (bytes[full] ?? 0) << 16
    out += ALPHABET[(chunk >> 18) & 63]! + ALPHABET[(chunk >> 12) & 63]! + '=='
  } else if (remaining === 2) {
    const chunk = ((bytes[full] ?? 0) << 16) | ((bytes[full + 1] ?? 0) << 8)
    out +=
      ALPHABET[(chunk >> 18) & 63]! +
      ALPHABET[(chunk >> 12) & 63]! +
      ALPHABET[(chunk >> 6) & 63]! +
      '='
  }
  return out
}

function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[\s=]+$/u, '')
  for (let index = 0; index < clean.length; index += 1) {
    const code = clean.charCodeAt(index)
    if (code > 127 || LOOKUP[code] === -1) {
      throw new Error(`invalid base64 character at ${index}`)
    }
  }
  const byteLength = Math.floor((clean.length * 6) / 8)
  const bytes = new Uint8Array(byteLength)
  let accumulator = 0
  let bits = 0
  let cursor = 0
  for (let index = 0; index < clean.length; index += 1) {
    accumulator = (accumulator << 6) | (LOOKUP[clean.charCodeAt(index)] ?? 0)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[cursor] = (accumulator >> bits) & 0xff
      cursor += 1
    }
  }
  return bytes
}

/** Pack a mask where any non-zero pixel counts as ink. */
export function packBitmap(mask: Uint8Array | Uint8ClampedArray): string {
  const bytes = new Uint8Array(Math.ceil(mask.length / 8))
  for (let index = 0; index < mask.length; index += 1) {
    if ((mask[index] ?? 0) !== 0) {
      const byteIndex = index >> 3
      bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (0x80 >> (index & 7))
    }
  }
  return bytesToBase64(bytes)
}

/** Unpack into a mask of 0/255 values with exactly `pixelCount` entries. */
export function unpackBitmap(encoded: string, pixelCount: number): Uint8Array {
  if (!Number.isInteger(pixelCount) || pixelCount < 0) {
    throw new Error(`invalid pixel count: ${pixelCount}`)
  }
  const bytes = base64ToBytes(encoded)
  if (bytes.length < Math.ceil(pixelCount / 8)) {
    throw new Error(`bitmap too short: expected ${pixelCount} pixels`)
  }
  const mask = new Uint8Array(pixelCount)
  for (let index = 0; index < pixelCount; index += 1) {
    const byte = bytes[index >> 3] ?? 0
    mask[index] = (byte & (0x80 >> (index & 7))) !== 0 ? 255 : 0
  }
  return mask
}

/** Count ink pixels without materialising the mask. */
export function countInk(encoded: string, pixelCount: number): number {
  const mask = unpackBitmap(encoded, pixelCount)
  let ink = 0
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 0) ink += 1
  }
  return ink
}
