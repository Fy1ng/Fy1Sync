import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DECODER_PREFERENCES_FILE, DecoderPreferences } from './decoderPreferences'

describe('process decoder preferences', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'stream-sync-decoder-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('defaults to existing automatic decoding without creating a file', async () => {
    expect(new DecoderPreferences(directory).get()).toEqual({ mode: 'auto', effectiveMode: 'auto', restartRequired: false, forcedByCommandLine: false })
    expect(await readdir(directory)).toEqual([])
  })

  it('persists valid selections atomically and changes effective mode only at next startup', async () => {
    const preferences = new DecoderPreferences(directory)
    expect(await preferences.set('software')).toEqual({ mode: 'software', effectiveMode: 'auto', restartRequired: true, forcedByCommandLine: false })
    expect(JSON.parse(await readFile(join(directory, DECODER_PREFERENCES_FILE), 'utf8'))).toEqual({ version: 1, mode: 'software' })
    expect(await readdir(directory)).toEqual([DECODER_PREFERENCES_FILE])
    const restarted = new DecoderPreferences(directory)
    expect(restarted.get()).toMatchObject({ mode: 'software', effectiveMode: 'software', restartRequired: false })
    expect(await restarted.set('auto')).toMatchObject({ mode: 'auto', effectiveMode: 'software', restartRequired: true })
    expect(new DecoderPreferences(directory).get()).toMatchObject({ mode: 'auto', effectiveMode: 'auto', restartRequired: false })
  })

  it.each(['{broken', 'null', '[]', '{"mode":"software"}', '{"version":2,"mode":"software"}',
    '{"version":1,"mode":"unknown"}', '{"version":1,"mode":true}', '{"version":1,"mode":"software","extra":1}', 'x'.repeat(4097)])(
    'falls back to auto for malformed, unknown or oversized persisted input', async text => {
      await writeFile(join(directory, DECODER_PREFERENCES_FILE), text)
      expect(new DecoderPreferences(directory).get().effectiveMode).toBe('auto')
    })

  it('reports a software command-line override separately from saved preference', () => {
    expect(new DecoderPreferences(directory, true).get()).toEqual({ mode: 'auto', effectiveMode: 'software', restartRequired: true, forcedByCommandLine: true })
  })

  it('rejects invalid runtime values before writing', async () => {
    const preferences = new DecoderPreferences(directory)
    await expect(preferences.set('invalid' as never)).rejects.toThrow('Invalid decoder mode')
    expect(await readdir(directory)).toEqual([])
  })

  it('does not publish success when atomic rename fails and removes the temporary file', async () => {
    await mkdir(join(directory, DECODER_PREFERENCES_FILE))
    const preferences = new DecoderPreferences(directory)
    await expect(preferences.set('software')).rejects.toThrow()
    expect(preferences.get()).toMatchObject({ mode: 'auto', effectiveMode: 'auto', restartRequired: false })
    expect(await readdir(directory)).toEqual([DECODER_PREFERENCES_FILE])
  })

  it('preserves the previous disk and memory state when persistence fails', async () => {
    await new DecoderPreferences(directory).set('software')
    const preferences = new DecoderPreferences(directory, false, async () => { throw new Error('disk unavailable') })
    await expect(preferences.set('auto')).rejects.toThrow('disk unavailable')
    expect(preferences.get()).toMatchObject({ mode: 'software', effectiveMode: 'software', restartRequired: false })
    expect(new DecoderPreferences(directory).get().mode).toBe('software')
  })

  it('serializes writes and allows another save after a failure', async () => {
    let release!: () => void
    const order: string[] = []
    const preferences = new DecoderPreferences(directory, false, async (_directory, _file, mode) => {
      order.push(mode)
      if (order.length === 1) { await new Promise<void>(resolve => { release = resolve }); throw new Error('first write failed') }
    })
    const first = preferences.set('software')
    const rejected = expect(first).rejects.toThrow('first write failed')
    const second = preferences.set('auto')
    await Promise.resolve()
    expect(order).toEqual(['software'])
    release()
    await rejected
    expect(await second).toMatchObject({ mode: 'auto', restartRequired: false })
    expect(order).toEqual(['software', 'auto'])
  })
})
