import { types as utilTypes } from 'node:util'
import { parse, type DefaultTreeAdapterTypes, type ParserError } from 'parse5'
import type { DouyuBackpackItem, DouyuRenewalTarget } from './renewalTypes'

const MAX_HTML_BYTES = 1_048_576
const MAX_ROWS = 128
const MAX_ITEMS = 256
const MAX_UNIX_SECONDS = 253_402_300_799 // Last second representable with a four-digit UTC year.
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'
const INERT_ELEMENTS = new Set(['script', 'style', 'template', 'noscript', 'textarea', 'iframe', 'object', 'embed', 'select', 'xmp', 'plaintext'])
const EMPTY_BADGE_TEXT = new Set(['暂无粉丝牌', '暂无粉丝徽章', '您还没有粉丝牌', '你还没有粉丝牌'])
const CONTROL_TEXT = /[\x00-\x1f\x7f-\x9f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\uD800-\uDFFF]/gu
type HtmlNode = DefaultTreeAdapterTypes.Node
type HtmlElement = DefaultTreeAdapterTypes.Element

export class RenewalInventoryError extends Error {
  constructor() {
    super('斗鱼续牌列表或背包数据无法确认, 请刷新后重试.')
    this.name = 'RenewalInventoryError'
  }
}

function fail(): never { throw new RenewalInventoryError() }
function element(node: HtmlNode): node is HtmlElement { return 'tagName' in node }
function ignored(node: HtmlNode): boolean {
  return element(node) && (node.namespaceURI !== HTML_NAMESPACE || INERT_ELEMENTS.has(node.tagName))
}
function attr(node: HtmlElement, name: string): string | undefined { return node.attrs.find(attribute => attribute.name === name)?.value }
function marked(node: HtmlElement): boolean { return (attr(node, 'class') ?? '').split(/[\t\n\f\r ]+/).includes('fans-badge-list') }
function normalizedText(value: string): string { return value.replace(CONTROL_TEXT, '').replace(/\s+/gu, ' ').trim() }

function descendants(root: HtmlNode, visitor: (node: HtmlNode, depth: number) => boolean | void, onIgnored?: (node: HtmlNode) => void): void {
  let visited = 0
  const walk = (node: HtmlNode, depth: number) => {
    if (++visited > 20_000 || depth > 128) fail()
    if (ignored(node)) { onIgnored?.(node); return }
    if (visitor(node, depth) === false) return
    if ('childNodes' in node) for (const child of node.childNodes) walk(child, depth + 1)
  }
  walk(root, 0)
}

function rowText(row: HtmlElement): string {
  const parts: string[] = []
  descendants(row, node => {
    if (node !== row && element(node) && node.tagName === 'table') return false
    if (node.nodeName === '#text' && 'value' in node) parts.push(node.value)
  })
  return normalizedText(parts.join(' '))
}

/** Compare parsed metadata, never private raw HTML or temporary DOM positions. */
function rowFingerprint(row: HtmlElement): string {
  const parts: unknown[] = []
  descendants(row, (node, depth) => {
    if (node !== row && element(node) && node.tagName === 'table') return false
    if (element(node)) parts.push([depth, node.tagName, node.attrs.map(item => [item.name, item.value]).sort(([left], [right]) => left! < right! ? -1 : left! > right! ? 1 : 0)])
    else if (node.nodeName === '#text' && 'value' in node) {
      const value = node.value.replace(/\s+/gu, ' ').trim()
      if (value) parts.push([depth, 'text', value])
    }
  })
  const result = JSON.stringify(parts)
  if (result.length > 16_384) fail()
  return result
}

function inHeaderOrFooter(row: HtmlElement, table: HtmlElement): boolean {
  for (let node = row.parentNode; node && node !== table; node = 'parentNode' in node ? node.parentNode : null) {
    if (element(node) && (node.tagName === 'thead' || node.tagName === 'tfoot')) return true
  }
  return false
}

/** Returns only rows on this page; it neither establishes pagination nor renewal state. */
export function parseRenewalTargets(html: string, acquisition?: { now: number }): DouyuRenewalTarget[] {
  try {
    if (acquisition && (!Number.isSafeInteger(acquisition.now) || acquisition.now < 0)) fail()
    if (typeof html !== 'string' || !html.trim() || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) fail()
    const errors: ParserError[] = []
    const document = parse(html, { scriptingEnabled: true, sourceCodeLocationInfo: true, onParseError: error => {
      if (errors.length >= 1_000) fail()
      if (error.code !== 'missing-doctype' && error.code !== 'non-conforming-doctype') errors.push(error)
    } })
    const tables: Array<{ table: HtmlElement; marker: HtmlElement }> = []
    descendants(document, node => {
      if (!element(node)) return
      if (node.tagName === 'title' && /登录|登錄|\blog[ -]?in\b|\bsign[ -]?in\b/i.test(rowText(node))) fail()
      if (node.tagName !== 'table') return
      let marker: HtmlElement | undefined
      for (let parent: HtmlNode | null = node; parent; parent = 'parentNode' in parent ? parent.parentNode : null) {
        if (element(parent) && marked(parent)) { marker = parent; break }
      }
      if (!marker) return
      tables.push({ table: node, marker })
      if (tables.length > 8) fail()
      return false
    }, node => {
      // HTML parsing can move a table out of malformed SVG/MathML without a parse error.
      if (!element(node) || node.namespaceURI === HTML_NAMESPACE) return
      const location = node.sourceCodeLocation
      if (location?.startTag && !location.endTag && !html.slice(location.startTag.startOffset, location.startTag.endOffset).trimEnd().endsWith('/>')) fail()
    })
    if (!tables.length) fail()
    const found = new Map<string, { target: DouyuRenewalTarget; fingerprint: string }>()
    let rowCount = 0
    let emptyTables = 0
    for (const { table, marker } of tables) {
      const location = table.sourceCodeLocation
      const markerLocation = marker.sourceCodeLocation?.startTag
      if (!location?.startTag || !location.endTag || !markerLocation) fail()
      if (errors.some(error => (error.startOffset >= location.startOffset && error.startOffset < location.endOffset)
        || (error.startOffset >= markerLocation.startOffset && error.startOffset < markerLocation.endOffset))) fail()
      let targetRows = 0
      let explicitEmpty = false
      descendants(table, node => {
        if (!element(node)) return
        if (node !== table && node.tagName === 'table') return false
        if (node.tagName !== 'tr') return
        const cells = node.childNodes.filter((child): child is HtmlElement => element(child) && ['td', 'th'].includes(child.tagName))
        const room = attr(node, 'data-fans-room')
        if (room !== undefined) {
          if (!node.sourceCodeLocation?.startTag || !/^[1-9][0-9]{0,11}$/.test(room)
            || !cells.some(cell => cell.tagName === 'td') || ++rowCount > MAX_ROWS) fail()
          targetRows++
          const fingerprint = rowFingerprint(node)
          const previous = found.get(room)
          if (previous && previous.fingerprint !== fingerprint) fail()
          // The pinned reference proves the room attribute, but no reliable badge-name field.
          if (!previous) {
            const target: DouyuRenewalTarget = { room, badgeName: `房间 ${room}` }
            if (acquisition) {
              const raw = attr(node, 'data-fans-gbdgts')
              const seconds = raw && /^[1-9][0-9]{0,11}$/.test(raw) ? Number(raw) : null
              target.acquiredAt = seconds !== null && seconds <= MAX_UNIX_SECONDS && seconds * 1000 <= acquisition.now ? seconds * 1000 : null
              target.heldDays = target.acquiredAt === null ? null : Math.floor((acquisition.now - target.acquiredAt) / 86_400_000)
            }
            found.set(room, { target, fingerprint })
          }
        } else {
          if (node.attrs.some(attribute => attribute.name.startsWith('data-fans-'))) fail()
          if (inHeaderOrFooter(node, table) || cells.some(cell => cell.tagName === 'th')) return false
          const text = rowText(node)
          if (EMPTY_BADGE_TEXT.has(text.replace(/\s+/gu, '').replace(/[.。!！]$/u, ''))) explicitEmpty = true
          else if (text) fail()
        }
        return false
      })
      if ((!targetRows && !explicitEmpty) || (targetRows && explicitEmpty)) fail()
      if (explicitEmpty) emptyTables++
    }
    if (emptyTables && found.size) fail()
    return [...found.values()].map(({ target }) => ({ ...target }))
  } catch { throw new RenewalInventoryError() }
}

function ownFields(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || utilTypes.isProxy(raw) || Array.isArray(raw)) fail()
  const prototype: unknown = Object.getPrototypeOf(raw)
  if (prototype !== Object.prototype && prototype !== null) fail()
  const keys = Reflect.ownKeys(raw)
  if (keys.length > 128) fail()
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    if (typeof key !== 'string') fail()
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)
    if (!descriptor || !('value' in descriptor)) fail()
    fields[key] = descriptor.value
  }
  return fields
}

function dataItems(raw: unknown): unknown[] {
  if (!raw || typeof raw !== 'object' || utilTypes.isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) fail()
  const length: unknown = Object.getOwnPropertyDescriptor(raw, 'length')?.value
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > MAX_ITEMS
    || Reflect.ownKeys(raw).length !== length + 1) fail()
  const result: unknown[] = []
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index))
    if (!descriptor || !('value' in descriptor)) fail()
    result.push(descriptor.value)
  }
  return result
}

function unsigned(raw: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  const number = typeof raw === 'number' ? raw : typeof raw === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(raw) ? Number(raw) : NaN
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : null
}
function valuable(raw: unknown): boolean | null {
  if (raw === false || raw === 0 || raw === '0') return false
  if (raw === true || raw === 1 || raw === '1') return true
  return null
}
function expirySeconds(raw: unknown): number | null { return raw === -1 || raw === '-1' ? -1 : unsigned(raw, MAX_UNIX_SECONDS) }
function itemName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 256) fail()
  const value = normalizedText(raw)
  if (!value || value.length > 128) fail()
  return value
}

function ineligibleReason(item: Omit<DouyuBackpackItem, 'eligible' | 'reason'>, nowMs: number): string | null {
  if (!['268', '2358'].includes(item.id) || !item.name.includes('荧光棒')) return '非本次荧光棒候选'
  if (item.propType === null) return '道具类型未确认'
  if (item.propType === 5) return '领取入口, 不执行领取'
  if (item.propType >= 7 && item.propType <= 10) return '兑换道具, 不用于本次赠送'
  if (![0, 1, 2].includes(item.propType)) return '特殊或未知道具类型, 不用于本次赠送'
  if (item.isClick === null) return '使用状态未确认'
  if (item.isClick <= 0) return '当前不可使用'
  if (item.isValuable === null) return '价值属性未确认'
  if (item.isValuable) return '有价值道具, 不用于本次赠送'
  if (!item.count) return '库存不足'
  if (item.met === null) return '有效期未确认'
  if (item.met !== -1 && item.met * 1_000 <= nowMs + 5_000) return '已过期或即将过期'
  return null
}

/** Parses the already-decoded inner payload; unknown eligibility never becomes permission. */
export function parseRenewalInventory(payload: unknown, nowMs: number): DouyuBackpackItem[] {
  try {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > MAX_UNIX_SECONDS * 1_000) fail()
    const fields = ownFields(payload)
    if (Object.hasOwn(fields, 'error') && fields.error !== 0 && fields.error !== '0') fail()
    if (Object.hasOwn(fields, 'success') && fields.success !== true && fields.success !== 1 && fields.success !== '1') fail()
    const rows = dataItems(fields.list)
    const ids = new Set<string>()
    return rows.map(raw => {
      const data = ownFields(raw)
      const numericId = unsigned(data.id)
      const count = unsigned(data.count)
      if (numericId === null || numericId === 0 || count === null) fail()
      const id = String(numericId)
      // A duplicate may be a second stock lot; neither sum it nor silently drop it.
      if (ids.has(id)) fail()
      ids.add(id)
      const item = { id, name: itemName(data.name), count, met: expirySeconds(data.met),
        propType: unsigned(data.propType, 255), isClick: unsigned(data.isClick, 255), isValuable: valuable(data.isValuable) }
      const reason = ineligibleReason(item, nowMs)
      return { ...item, eligible: reason === null, reason }
    })
  } catch { throw new RenewalInventoryError() }
}
