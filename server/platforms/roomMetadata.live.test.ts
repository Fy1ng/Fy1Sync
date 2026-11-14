import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createRoomMetadataCollector } from './roomMetadata'
import { createDouyuRoomResolver } from './douyuRoom'
import { resolveConfig } from '../config'

const enabled = process.env.STREAM_SYNC_ROOM_METADATA_LIVE_TESTS === '1'
const root = enabled ? fs.mkdtempSync(path.join(os.tmpdir(), 'room-metadata-live-')) : ''
afterAll(() => {
  if (root && path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('room-metadata-live-')) fs.rmSync(root, { recursive: true, force: true })
})
describe.skipIf(!enabled)('anonymous public room metadata', () => {
  const proxy = resolveConfig({}).proxy
  const collect = createRoomMetadataCollector({ proxy, userDataDir: root, resolveRoom: createDouyuRoomResolver(proxy).resolve })
  it.each([
    ['douyu', 'https://www.douyu.com/6657'],
    ['bilibili', 'https://live.bilibili.com/6'],
    ['huya', 'https://www.huya.com/660000'],
    ['douyin', 'https://live.douyin.com/294991263559'],
    ['twitch', 'https://www.twitch.tv/eslcs'],
    ['youtube', 'https://www.youtube.com/@PGL/live'],
  ])('reads %s without an account or playback', async (platform, input) => {
    const metadata = await collect({ platform, input, id: 'test-room', savedAt: 1, role: 'official', label: '测试房间' }, AbortSignal.timeout(25_000))
    console.log(JSON.stringify({ platform, nickname: metadata.nickname, status: metadata.status, lastStartedAt: metadata.lastStartedAt, hasAvatar: !!metadata.avatarUrl }))
    expect(metadata.nickname).not.toBe('')
    expect(metadata.status).not.toBe('unknown')
    expect(metadata.avatarUrl).toMatch(/^\/room-image\/[a-f0-9]{64}\./)
  }, 30_000)
})
