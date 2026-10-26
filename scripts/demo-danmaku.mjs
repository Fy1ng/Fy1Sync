/**
 * Try danmaku without a live room: opens the built app offline with a fake Douyu room.
 *
 * Not a test and not part of the suite. It uses the same main-process hooks the E2E specs
 * use (offline mode, no network at all), then leaves the window to you:
 *
 *   npm run build              (or: npx vite build && node scripts/build-electron.mjs)
 *   node scripts/demo-danmaku.mjs [--rate 6] [--no-video] [--shot file.png]
 *
 * What it sets up:
 * - a fake room 288016 that keeps producing chat, colours, long lines and glow-stick gifts;
 * - the two looping test clips (unless --no-video), so danmaku follow a real commentary
 *   playhead and react to rewinding it;
 * - a fake Douyu login, so the send box and +1 work; whatever you send comes back into the
 *   room as your own message, the way it would on Douyu.
 *
 * Close the window to stop. The profile is temporary and is deleted afterwards.
 */

import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from '@playwright/test'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] ? Number(argv[at + 1]) : fallback
}
const ROOM = '288016'
const RATE = Math.max(1, Math.min(60, value('rate', 6)))

const root = fileURLToPath(new URL('../', import.meta.url))
const profile = join(root, '.runtime-cache', 'demo-danmaku', randomUUID())
await mkdir(join(profile, 'temp'), { recursive: true })

const env = Object.fromEntries(Object.entries(process.env).filter(([name, v]) => v !== undefined
  && !/^STREAM_SYNC_/i.test(name) && !/^ELECTRON_RUN_AS_NODE$/i.test(name)))
Object.assign(env, {
  STREAM_SYNC_E2E: '1', STREAM_SYNC_OFFLINE_E2E: '1',
  STREAM_SYNC_USER_DATA_DIR: profile, STREAM_SYNC_DATA_DIR: join(profile, 'data'),
  TEMP: join(profile, 'temp'), TMP: join(profile, 'temp'),
})

const app = await _electron.launch({ args: [join(root, 'dist/electron/main.cjs')], cwd: root, env })
const page = await app.firstWindow()
await page.waitForURL('app://app/**', { timeout: 30_000 })
await page.waitForFunction(() => typeof window.streamSyncer?.invoke === 'function')
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
await app.evaluate((_electron, room) => {
  const hook = globalThis.__streamSyncerTest
  hook.setDouyuRoomFixture({ [room]: room })
  hook.setDouyuToolsFixture()
}, ROOM)

// Sign the default account in through the fixture login, so sending is possible.
await page.evaluate(async () => {
  const accounts = await window.streamSyncer.invoke('listDouyuAccounts', undefined)
  const id = accounts.ok ? accounts.value.activeAccountId ?? accounts.value.accounts[0]?.id : null
  if (id) await window.streamSyncer.invoke('loginDouyuAccount', { id })
})

// The room itself: a steady stream with bursts, the odd long line, gifts and repeat users.
await app.evaluate((_electron, { room, rate }) => {
  const hook = globalThis.__streamSyncerTest
  const lines = ['这波指挥有问题', '哈哈哈哈哈哈', '解说说得对', '666666', 'A队要翻盘了', '前面的挡住了', '这枪法太离谱',
    '关注主播抽奖', '经济差多少了', '残局看这个', '刚才那个闪光太准了', '主播声音大点', '稳了稳了', '？？？',
    '这把是不是要加时', '解说这个预判可以的', '好家伙一换三', '回放回放', '对面教练暂停了', '这个道具丢得好',
    '我觉得这局还是看经济，下一把手枪局很关键，输了基本就没了', '前排', '晚上好', '这个解说讲得比官方还清楚']
  const users = ['夜猫子', '残局之王', '小鱼干', '老观众', '路过的', '狙击手阿强', '今天也在看', '云教练', '一条咸鱼', '鱼丸收集者']
  let seq = 0
  const emit = (text, user, uid, extra = {}) => hook.emitDanmaku(room, 'danmaku', {
    id: `demo-${++seq}`, text, username: user, color: seq % 9 === 0 ? 1 + (seq % 6) : 0, level: 10 + (uid % 40),
    receivedAt: Date.now(), room, system: false, sender: { uid: String(100000 + uid), level: 10 + (uid % 40), nobleLevel: 0 }, ...extra,
  })
  hook.emitDanmaku(room, 'state', { room, state: 'connected' })
  setInterval(() => hook.emitDanmaku(room, 'state', { room, state: 'connected' }), 5000)
  let burst = 0
  setInterval(() => {
    if (Math.random() < 0.04) burst = 12
    // `rate` per second over ten ticks a second: the whole part every tick, the rest by chance.
    const count = burst > 0 ? (burst--, 3) : Math.floor(rate / 10) + (Math.random() < (rate % 10) / 10 ? 1 : 0)
    for (let i = 0; i < count; i++) {
      const uid = Math.floor(Math.random() * users.length)
      emit(lines[Math.floor(Math.random() * lines.length)], users[uid], uid)
    }
    if (Math.random() < 0.02) {
      const uid = Math.floor(Math.random() * users.length)
      emit('粉丝荧光棒 x ' + (1 + Math.floor(Math.random() * 5)), users[uid], uid, { system: true, gift: { kind: 'prop', id: '268', count: 3 } })
    }
  }, 100)
  // Echo what you send, as Douyu would show it back to you.
  let echoed = 0
  setInterval(() => {
    const sent = hook.getDouyuSentFixture()
    for (; echoed < sent.length; echoed++) emit(sent[echoed].text, '我', 7, { color: sent[echoed].color })
  }, 300)
}, { room: ROOM, rate: RATE })

// Drive the screen to a ready state, then hand it over.
await page.getByRole('dialog', { name: '添加直播间' }).waitFor({ timeout: 10_000 }).catch(() => {})
if (!flag('no-video')) {
  const fixtures = page.getByRole('button', { name: '载入测试片源' })
  if (await fixtures.isVisible().catch(() => false)) await fixtures.click()
  else console.log('没有测试片源（先运行 npm run fixtures），只演示弹幕。')
}
const skip = page.getByRole('button', { name: /^(跳过|开始观看)$/ })
await page.waitForTimeout(1500)
if (await skip.isVisible().catch(() => false)) await skip.click()
await page.getByRole('button', { name: /^解说：/ }).click()
await page.getByRole('button', { name: /^(连接|更换房间)$/ }).click()
await page.getByLabel('弹幕房间号').fill(ROOM)
await page.getByRole('button', { name: '连接', exact: true }).click()
await page.keyboard.press('Escape')
await page.evaluate(() => {
  // Open the chat drawer if it is closed; C is its shortcut.
  if (!document.querySelector('.drawer')) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC' }))
})

const shot = argv.indexOf('--shot')
if (shot >= 0 && argv[shot + 1]) {
  await page.waitForTimeout(5000)
  await page.mouse.move(400, 300)
  await page.screenshot({ path: argv[shot + 1] })
  await app.close()
  process.exit(0)
}

console.log(`弹幕演示已打开：假房间 ${ROOM}，约每秒 ${RATE} 条。关闭窗口即结束。`)
await new Promise((resolve) => app.once('close', resolve))
await rm(join(root, '.runtime-cache', 'demo-danmaku'), { recursive: true, force: true }).catch(() => {})
