import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * Start every run from an empty preset store.
 *
 * The suite teaches a real profile through the API, so each run leaves a file behind in
 * `e2e/.data/presets`. Left to accumulate they are not merely untidy: the preset ids are
 * timestamped to keep the player's picker unambiguous, which means a leftover store also
 * hides bugs — a seed that should have reported "created" reports "updated" instead, and
 * nothing notices. Clearing it also keeps `list()` from re-reading and parsing a directory
 * that grows by one file per run forever.
 *
 * Safe to delete outright: the directory is gitignored, written only by these tests, and
 * pointed at by `STREAM_SYNC_DATA_DIR` in the webServer config — never the developer's
 * own `data/`.
 */
export default async function globalSetup(): Promise<void> {
  const dataDir = fileURLToPath(new URL('./.data', import.meta.url))
  await rm(dataDir, { recursive: true, force: true })
}
