import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import type { SourceRole } from '../src/core/types'
import { loadSource } from './helpers'

export async function loadRecordingSource(page: Page, role: SourceRole, file: string, name: string = role): Promise<void> {
  const input = `/test-sources/e2e-recordings/${name}.mp4`
  const url = `app://app${input}`
  await page.unroute(url)
  await page.route(url, async route => {
    const body = await readFile(file)
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '')
    const start = range ? Number(range[1]) : 0
    const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
    if (start > end || start >= body.length) {
      await route.fulfill({ status: 416, headers: { 'Content-Range': `bytes */${body.length}` } })
      return
    }
    await route.fulfill({
      status: range ? 206 : 200,
      contentType: 'video/mp4',
      headers: {
        'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}),
      },
      body: body.subarray(start, end + 1),
    })
  })
  await loadSource(page, role, input)
}
