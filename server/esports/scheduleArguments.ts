import { FeatureApiError } from '../featureApiError'
import { object } from './metadataIo'

const invalid = (): never => { throw new FeatureApiError('invalid-arguments') }

export function scheduleArguments(raw: unknown): { refresh?: boolean } | undefined {
  if (raw === undefined) return undefined
  if (!object(raw) || Object.keys(raw).some(key => key !== 'refresh') || (raw.refresh !== undefined && typeof raw.refresh !== 'boolean')) return invalid()
  return raw as { refresh?: boolean }
}

export function scheduleFocusArguments(raw: unknown, maxPathLength = 500): { eventPath: string | null } {
  if (!object(raw) || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, 'eventPath')) return invalid()
  const value = raw.eventPath
  if (value === null) return { eventPath: null }
  if (typeof value !== 'string' || value.length > maxPathLength || !value.startsWith('/counterstrike/') || /[?#\\]/.test(value)) return invalid()
  return { eventPath: value }
}

export function verificationRoundArgument(raw: unknown): string {
  if (!object(raw) || Object.keys(raw).length !== 1 || typeof raw.round !== 'string' || !/^[a-f\d:-]{1,64}$/.test(raw.round)) return invalid()
  return raw.round
}
