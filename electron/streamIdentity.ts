import type { SourceRole } from '../src/core/types'

/** Synchronization roles stay fixed; independently owned streams use opaque ids. */
export type StreamId = SourceRole | `stream-${string}`
export const isStreamId = (value: unknown): value is StreamId => typeof value === 'string'
  && /^(?:official|commentary|stream-[a-f0-9]{32})$/.test(value)
export const isExtraStreamId = (value: unknown): value is `stream-${string}` =>
  isStreamId(value) && value.startsWith('stream-')
