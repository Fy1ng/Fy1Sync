/**
 * Smoke-test a running server — the built one, by default.
 *
 * `npm test` covers the API against an in-process server and Playwright covers the pages,
 * but neither exercises `dist/server/index.mjs`: the bundle, the static-file handler
 * serving Vite's hashed output, and the data directory as an operator would see them.
 * Nothing else checks that what ships actually starts and serves.
 *
 * Requests go through `fetch` rather than curl on purpose. A shell on Windows re-encodes
 * non-ASCII arguments to the console codepage, which turns a Chinese preset name into
 * mojibake before it ever reaches the socket — an encoding bug in the *test* that looks
 * exactly like one in the server.
 *
 *   node scripts/smoke.mjs [--base http://127.0.0.1:5178] [--token stream-sync-admin]
 *
 * The defaults mirror the server's own (`server/config.ts`), so `npm start` in one terminal
 * and `npm run smoke` in another needs no flags on either side. They are only defaults:
 * `STREAM_SYNC_PORT` and `STREAM_SYNC_ADMIN_TOKEN` are read the same way the server reads
 * them, and a wrong token shows up as the whole preset section failing 403.
 *
 * Exits non-zero on the first failed check.
 */

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

const port = Number(process.env.STREAM_SYNC_PORT) || 5178
const host = process.env.STREAM_SYNC_HOST?.trim() || '127.0.0.1'
const base = flag('base', `http://${host}:${port}`).replace(/\/$/, '')
const token = flag('token', process.env.STREAM_SYNC_ADMIN_TOKEN?.trim() || 'stream-sync-admin')

let failures = 0
let checks = 0

function check(label, actual, expected) {
  checks += 1
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected
  if (pass) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${label}\n       got ${JSON.stringify(actual)}`)
  return false
}

const url = (path) => `${base}${path}`

async function main() {
  console.log(`\n冒烟测试 ${base}\n`)

  console.log('静态资源与页面')
  const health = await fetch(url('/api/health'))
  check('/api/health 返回 200', health.status, 200)
  const healthBody = await health.json()
  check('/api/health 报告 ok', healthBody.ok, true)
  check('/api/health 带版本号', typeof healthBody.version === 'string' && healthBody.version.length > 0, true)

  const index = await fetch(url('/'))
  check('/ 返回 200', index.status, 200)
  const html = await index.text()
  check('/ 是构建产物而不是源文件', html.includes('/assets/'), true)
  check('/ 不含 Vite 开发客户端', html.includes('/@vite/client'), false)

  // The SPA serves the same shell for its own routes; a 404 here means a deploy that
  // works until the user reloads on /admin.
  check('/admin 由前端路由接住', (await fetch(url('/admin'))).status, 200)

  const asset = html.match(/\/assets\/[A-Za-z0-9._-]+\.js/)?.[0]
  if (check('index.html 引用了带哈希的脚本', Boolean(asset), true)) {
    const script = await fetch(url(asset))
    check(`${asset} 返回 200`, script.status, 200)
    check(`${asset} 是 JavaScript`, (script.headers.get('content-type') ?? '').includes('javascript'), true)

    // Seeking is this tool's core operation — it rewinds one stream by up to 60 s to meet the
    // other — and a `<video>` seeks by asking for a byte range. Checked here rather than only
    // in the unit tests because a reverse proxy in front of this server can strip ranges, and
    // then playback still starts and only seeking breaks.
    const ranged = await fetch(url(asset), { headers: { range: 'bytes=0-9' } })
    check('片段请求回 206', ranged.status, 206)
    check('片段请求带 content-range', ranged.headers.get('content-range'), (v) => /^bytes 0-9\/\d+$/.test(v ?? ''))
    check('片段请求只回这 10 个字节', (await ranged.text()).length, 10)
    check('声明支持片段请求', ranged.headers.get('accept-ranges'), 'bytes')
  }

  console.log('\n接口边界')
  const unknown = await fetch(url('/api/nope'))
  check('未知接口 404', unknown.status, 404)
  check('未知接口回 JSON 而不是 index.html', (await unknown.json()).error?.code, 'not-found')

  const noToken = await fetch(url('/api/presets/smoke/x'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  check('无令牌写入被拒', noToken.status, 403)
  check('无令牌写入报 bad-token', (await noToken.json()).error?.code, 'bad-token')

  console.log('\n媒体代理 SSRF 防护')
  for (const [label, target, code] of [
    ['回环地址', 'http://127.0.0.1:9/secret', 'bad-port'],
    ['云元数据地址', 'http://169.254.169.254/latest/meta-data/', 'host-not-allowed'],
    ['内网地址', 'http://192.168.1.1/', 'host-not-allowed'],
    ['file 协议', 'file:///etc/passwd', 'bad-scheme'],
    ['白名单外的公网域名', 'https://example.com/a.m3u8', 'host-not-allowed'],
  ]) {
    const response = await fetch(url(`/api/proxy?url=${encodeURIComponent(target)}`))
    const body = await response.json().catch(() => ({}))
    check(`拒绝${label}（${body.error?.code ?? response.status}）`, body.error?.code, code)
  }

  console.log('\n预设读写与并发保护')
  const id = `smoke/roundtrip-${Date.now()}`
  // A Chinese name on purpose: this is the encoding path the whole product depends on.
  const name = '冒烟预设 · 决赛'
  const profile = {
    schemaVersion: 2,
    id,
    name,
    roi: { x: 0.44, y: 0.02, w: 0.12, h: 0.07 },
    clockFormat: 'm:ss',
    detectWindowSeconds: 3,
    sampleFps: 30,
    matchThreshold: 0.82,
    preprocess: { scale: 1, threshold: 128, invert: false },
    templates: {},
    updatedAt: 0,
  }
  const write = (body, etag) =>
    fetch(url(`/api/presets/${id}`), {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': token,
        ...(etag ? { 'if-match': `"${etag}"` } : {}),
      },
      body: JSON.stringify(body),
    })

  const created = await write(profile)
  check('首次写入 201', created.status, 201)
  const createdBody = await created.json()
  const etag = createdBody.etag
  check('返回 etag', typeof etag === 'string' && etag.length > 0, true)
  check('响应头带 ETag', (created.headers.get('etag') ?? '').includes(etag ?? 'x'), true)

  const read = await fetch(url(`/api/presets/${id}`))
  check('读回 200', read.status, 200)
  const readBody = await read.json()
  check('中文名称原样往返', readBody.profile?.name, name)

  const updated = await write({ ...profile, name: `${name} 2` }, etag)
  check('带正确 If-Match 更新 200', updated.status, 200)
  const newEtag = (await updated.json()).etag
  check('更新后 etag 变化', newEtag !== etag, true)

  const stale = await write({ ...profile, name: '覆盖' }, etag)
  check('过期 If-Match 被拒 409', stale.status, 409)
  check('过期写入报 conflict', (await stale.json()).error?.code, 'conflict')

  const invalid = await write({ schemaVersion: 2, id })
  check('非法配置 422', invalid.status, 422)
  const invalidBody = await invalid.json()
  check('非法配置报 invalid-profile', invalidBody.error?.code, 'invalid-profile')
  check('非法配置带 issues', Array.isArray(invalidBody.error?.issues) && invalidBody.error.issues.length > 0, true)

  const listed = await (await fetch(url('/api/presets'))).json()
  const entry = listed.presets?.find((preset) => preset.id === id)
  check('列表里能找到它', Boolean(entry), true)
  check('列表里的名称也没乱码', entry?.name, `${name} 2`)

  const removed = await fetch(url(`/api/presets/${id}`), {
    method: 'DELETE',
    headers: { 'x-admin-token': token },
  })
  check('删除 200', removed.status, 200)
  check('删除后读不到', (await fetch(url(`/api/presets/${id}`))).status, 404)

  console.log(`\n${checks - failures}/${checks} 项通过\n`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(`\n冒烟测试无法完成：${error instanceof Error ? error.message : String(error)}`)
  console.error('服务没起来的话，先运行 npm start。')
  process.exitCode = 1
})
