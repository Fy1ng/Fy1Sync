import { randomUUID } from 'node:crypto'
import { normalizeDouyuUid } from '../../src/core/douyuMetadata'
import type { ChatMessage } from './types'

export type GatewayEvidence = 'pending' | 'accepted' | 'rejected' | 'unknown'
export type RoomEchoEvidence = 'pending' | 'observed' | 'not-observed'
export interface DeliveryEvidence {
  id: string
  accountId: string
  room: string
  sentAt: number
  deadlineAt: number
  gateway: GatewayEvidence
  roomEcho: RoomEchoEvidence
  observedAt: number | null
  messageId: string | null
}
export interface DeliveryAttempt { accountId: string; room: string; uid: string; text: string; color?: number; sentAt?: number }
type PendingDelivery = { view: DeliveryEvidence; uid: string; text: string; color: number; closed: boolean }

/** Gateway acceptance and public room observation are independent evidence, never a resend trigger. */
export class DeliveryTracker {
  private readonly records = new Map<string, PendingDelivery>()
  private readonly observedIds = new Set<string>()
  private readonly now: () => number
  private readonly id: () => string
  private readonly capacity: number
  private readonly windowMs: number

  constructor(options: { now?: () => number; id?: () => string; capacity?: number; windowMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.id = options.id ?? randomUUID
    this.capacity = options.capacity ?? 256
    this.windowMs = options.windowMs ?? 15_000
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 2_000
      || !Number.isInteger(this.windowMs) || this.windowMs < 1_000 || this.windowMs > 60_000) throw new Error('发送结果跟踪配置无效.')
  }

  begin(input: DeliveryAttempt): string {
    if (!input) throw new Error('发送结果跟踪参数无效.')
    const sentAt = input.sentAt ?? this.now()
    const color = input.color ?? 0
    if (!input || typeof input.accountId !== 'string' || !input.accountId || input.accountId.length > 128
      || /[\s\x00-\x1f\x7f]/.test(input.accountId)
      || !/^[1-9][0-9]{0,11}$/.test(input.room) || !normalizeDouyuUid(input.uid)
      || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 500
      || !Number.isSafeInteger(sentAt) || sentAt < 0 || sentAt > Number.MAX_SAFE_INTEGER - this.windowMs
      || !Number.isInteger(color) || color < 0 || color > 6) throw new Error('发送结果跟踪参数无效.')
    const id = this.id()
    if (typeof id !== 'string' || !id || id.length > 160 || this.records.has(id)) throw new Error('发送结果记录 ID 无效.')
    if (this.records.size >= this.capacity) this.records.delete(this.records.keys().next().value!)
    this.records.set(id, { uid: input.uid, text: input.text, color, closed: false, view: {
      id, accountId: input.accountId, room: input.room, sentAt, deadlineAt: sentAt + this.windowMs,
      gateway: 'pending', roomEcho: 'pending', observedAt: null, messageId: null,
    } })
    return id
  }

  accept(id: string): void { this.markGateway(id, 'accepted') }
  reject(id: string): void { this.markGateway(id, 'rejected') }
  uncertain(id: string): void { this.markGateway(id, 'unknown') }

  observe(message: ChatMessage): string | null {
    if (message?.platform === 'huya' || (typeof message?.room === 'string' && message.room.startsWith('huya:'))) return null
    this.expire()
    if (!message || message.system || message.gift || !message.sender?.uid || !message.id
      || !Number.isSafeInteger(message.receivedAt)) return null
    const key = JSON.stringify([message.room, message.id])
    if (this.observedIds.has(key)) return null
    const candidates = [...this.records.values()].filter(record => !record.closed && record.view.roomEcho === 'pending'
      && record.view.gateway !== 'rejected' && record.uid === message.sender!.uid && record.view.room === message.room
      && record.text === message.text && record.color === message.color && message.receivedAt >= record.view.sentAt
      && message.receivedAt <= record.view.deadlineAt)
    // Multiple identical in-flight messages cannot be attributed by text alone.
    if (candidates.length !== 1) return null
    const candidate = candidates[0]!
    candidate.view.roomEcho = 'observed'
    candidate.view.observedAt = message.receivedAt
    candidate.view.messageId = message.id
    this.observedIds.add(key)
    if (this.observedIds.size > this.capacity * 2) this.observedIds.delete(this.observedIds.values().next().value!)
    return candidate.view.id
  }

  get(id: string): DeliveryEvidence | null {
    this.expire()
    const record = this.records.get(id)
    return record ? { ...record.view } : null
  }

  list(accountId?: string): DeliveryEvidence[] {
    this.expire()
    return [...this.records.values()].filter(record => accountId === undefined || record.view.accountId === accountId).map(record => ({ ...record.view })).reverse()
  }

  cancelAccount(accountId: string): void {
    for (const record of this.records.values()) if (record.view.accountId === accountId) {
      if (record.view.gateway === 'pending') record.view.gateway = 'unknown'
      if (record.view.roomEcho === 'pending') record.view.roomEcho = 'not-observed'
      record.closed = true
    }
  }

  clear(): void { this.records.clear(); this.observedIds.clear() }

  private markGateway(id: string, evidence: Exclude<GatewayEvidence, 'pending'>): void {
    const record = this.records.get(id)
    if (!record || record.closed || record.view.gateway !== 'pending') return
    record.view.gateway = evidence
    if (evidence === 'rejected') {
      if (record.view.roomEcho === 'pending') record.view.roomEcho = 'not-observed'
      record.closed = true
    }
  }

  private expire(): void {
    const now = this.now()
    for (const record of this.records.values()) if (now >= record.view.deadlineAt) {
      if (record.view.gateway === 'pending') record.view.gateway = 'unknown'
      if (record.view.roomEcho === 'pending') record.view.roomEcho = 'not-observed'
      record.closed = true
      record.text = ''
      record.uid = ''
    }
  }
}
