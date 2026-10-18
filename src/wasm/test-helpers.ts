import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { dispatch, initSync, RecognitionEngine } from './pkg/stream_syncer_wasm.js'

// Tests instantiate the actual generated module from bytes, without a browser/fetch shim.
initSync({ module: readFileSync(join(process.cwd(), 'src/wasm/pkg/stream_syncer_wasm_bg.wasm')) })
export { RecognitionEngine as WasmRecognitionEngine }

export const parityCounts: Record<string, number> = {}
const parityFailures: string[] = []

/** Preserve numeric identity; only adapt container representations across JSON. */
export function plain(value: unknown): unknown {
  if (value instanceof Map) return Array.from(value, ([key, entry]) => [key, plain(entry)])
  if (ArrayBuffer.isView(value)) return Array.from(value as Uint8Array)
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, plain(entry)]))
  }
  return value
}

function jsonInput(value: unknown): string {
  return JSON.stringify(plain(value), (_key, entry: unknown) => {
    if (typeof entry !== 'number') return entry
    if (Number.isNaN(entry)) return { $number: 'NaN' }
    if (entry === Infinity) return { $number: 'Infinity' }
    if (entry === -Infinity) return { $number: '-Infinity' }
    if (Object.is(entry, -0)) return { $number: '-0' }
    return entry
  })
}

export function parseWasmJson(value: string): unknown {
  return JSON.parse(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || !('$number' in entry)) return entry
    switch ((entry as { $number: string }).$number) {
      case 'NaN': return Number.NaN
      case 'Infinity': return Infinity
      case '-Infinity': return -Infinity
      case '-0': return -0
      default: throw new Error('Unknown WASM numeric tag')
    }
  })
}

export function wasmCall(operation: string, args: readonly unknown[]): unknown {
  return parseWasmJson(dispatch(operation, jsonInput(args)))
}

export function assertExact(operation: string, actual: unknown, expected: unknown): void {
  try {
    expect(plain(actual), operation).toStrictEqual(plain(expected))
    parityCounts[operation] = (parityCounts[operation] ?? 0) + 1
  } catch (error) {
    // RecognitionEngine catches exceptions. Keep parity failures fatal even there.
    parityFailures.push(operation + ': ' + errorText(error))
    throw error
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Call TS first as the oracle, then compare all output fields with no float tolerance. */
export function checkParity<T>(operation: string, fn: (...args: never[]) => T, args: unknown[]): T {
  let expected: T
  try {
    expected = fn(...args as never[])
  } catch (oracleError) {
    let caught = false
    let wasmError: unknown
    try { wasmCall(operation, args) } catch (error) { caught = true; wasmError = error }
    assertExact(operation + ':throws', { caught, message: errorText(wasmError) },
      { caught: true, message: errorText(oracleError) })
    throw oracleError
  }
  try {
    assertExact(operation, wasmCall(operation, args), expected)
  } catch (error) {
    if (parityFailures.length === 0 || !parityFailures[parityFailures.length - 1]?.startsWith(operation + ':')) {
      parityFailures.push(operation + ': ' + errorText(error))
    }
    throw error
  }
  return expected
}

/** Export wrappers retain the TS values used by the original tests. */
export function wrapModule<T extends object>(actual: T, operations: readonly (keyof T)[]): T {
  const wrapped = { ...actual } as Record<string, unknown>
  for (const operation of operations) {
    const fn = actual[operation] as (...args: never[]) => unknown
    wrapped[String(operation)] = (...args: unknown[]) => checkParity(String(operation), fn, args)
  }
  return wrapped as T
}

export function assertParityIntegrity(label: string): void {
  expect(parityFailures, 'Parity mismatches swallowed by application error handling').toEqual([])
  expect(Object.values(parityCounts).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0)
  console.info(label + ' exact comparisons: ' + JSON.stringify(parityCounts))
}
