import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getQuickJS } from 'quickjs-emscripten';
import cookieTools from '../login/cookies.cjs';

let cookies;
try { cookies = cookieTools.createCookieContext(); }
catch { console.error('P0_COOKIES must be a valid Netscape cookie file inside prototype/.runtime/'); process.exit(1); }

// Throwaway P0 probe. Remote JavaScript is interpreted only by QuickJS WASM.
// No host functions or system interfaces are exposed to the remote code.
const prototype = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const media = resolve(prototype, '.media', 'douyu');
const evidence = resolve(prototype, '.evidence', 'douyu-quickjs.json');
const ffprobe = process.env.P0_FFPROBE || '<home>\\Desktop\\ffmpeg\\bin\\ffprobe.exe';
const MEMORY_LIMIT = 16 * 1024 * 1024;
const DEADLINE_MS = 500;
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const result = {
  item: 'douyu-quickjs', status: 'PARTIAL', startedAt: new Date().toISOString(),
  cookiesEnabled: cookies.enabled,
  nodeVersion: process.version, quickjsVersion: '0.32.0',
  commands: [
    "$env:NODE_USE_ENV_PROXY='1'; node prototype/douyu-quickjs/run.mjs",
    'ffprobe.exe -v error -http_proxy <existing proxy> -rw_timeout 15000000 -read_intervals %+3 -count_packets -show_entries stream=codec_type,codec_name,width,height,r_frame_rate,bit_rate,nb_read_packets:format=format_name,duration -of json <signed returned URL>',
  ],
  limits: { memoryLimitBytes: MEMORY_LIMIT, deadlineMs: DEADLINE_MS, maxStackBytes: 512 * 1024 },
  network: [], sandbox: {}, rooms: [], streams: [], problems: [],
};

await mkdir(media, { recursive: true });
await mkdir(dirname(evidence), { recursive: true });
const QuickJS = await getQuickJS();

function evalSandbox(code, filename) {
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT);
  runtime.setMaxStackSize(512 * 1024);
  const start = performance.now();
  const deadline = start + DEADLINE_MS;
  let interrupts = 0;
  runtime.setInterruptHandler(() => { interrupts += 1; return performance.now() > deadline; });
  const context = runtime.newContext();
  try {
    const evaluation = context.evalCode(code, filename);
    if (evaluation.error) {
      const error = context.dump(evaluation.error);
      evaluation.error.dispose();
      return { ok: false, error: cookies.enabled ? 'QuickJS execution failed; authenticated diagnostics omitted' : error,
        elapsedMs: Number((performance.now() - start).toFixed(3)), interrupts };
    }
    const value = context.dump(evaluation.value);
    evaluation.value.dispose();
    return { ok: true, value, elapsedMs: Number((performance.now() - start).toFixed(3)), interrupts };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

function scrub(value) {
  return cookies.diagnostics(value).replace(/https?:\/\/[^\s"'<>]+/g, '<URL redacted>').slice(0, 1200);
}

// Authenticated HTML, signing code or API responses could echo session data.
// Keep those responses in memory, and write only selected public measurements.
async function writePrivate(name, value) {
  if (!cookies.enabled) await writeFile(resolve(media, name), value);
}

async function fetchText(url, options = {}, label = 'request') {
  const start = performance.now();
  try {
    const cookie = cookies.headerFor(url);
    const response = await fetch(url, {
      ...options, headers: { 'User-Agent': ua, ...options.headers, ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(20000), redirect: 'error',
    });
    const text = await response.text();
    result.network.push({ label, host: new URL(url).hostname, status: response.status, bytes: Buffer.byteLength(text), elapsedMs: Number((performance.now() - start).toFixed(1)) });
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
    if (text.length > 2 * 1024 * 1024) throw new Error(`${label}: response exceeds 2 MiB`);
    return text;
  } catch (error) {
    result.network.push({ label, host: new URL(url).hostname, error: scrub(error.message), causeCode: error.cause?.code });
    throw error;
  }
}

async function fetchJson(url, options, label) {
  return JSON.parse(await fetchText(url, options, label));
}

async function selectLiveRoom() {
  const preferred = process.env.P0_DOUYU_ROOM || '9999';
  if (!/^\d{1,9}$/.test(preferred)) throw new Error('P0_DOUYU_ROOM must be numeric');
  const candidates = [preferred];
  const listed = await fetchJson('https://open.douyucdn.cn/api/RoomApi/live/1', {}, 'live-directory');
  for (const room of listed.data || []) {
    if (candidates.length >= 5) break;
    if (!candidates.includes(String(room.room_id))) candidates.push(String(room.room_id));
  }
  for (const id of candidates) {
    const json = await fetchJson(`https://open.douyucdn.cn/api/RoomApi/room/${id}`, {}, `room-status-${id}`);
    const item = { roomId: String(json.data?.room_id || id), roomStatus: String(json.data?.room_status), apiError: json.error };
    result.rooms.push(item);
    if (item.roomStatus === '1' && json.error === 0) return item.roomId;
  }
  throw new Error('No currently live room among five directory candidates');
}

async function signedParams(roomId) {
  const html = await fetchText(`https://m.douyu.com/${roomId}`, {}, 'mobile-room-page');
  await writePrivate('room.html', html);
  const ridMatch = html.match(/rid":(\d{1,9}),"vipId/);
  if (ridMatch) roomId = ridMatch[1];
  const match = html.match(/(function ub98484234[^\n]*)\n([^\n]*)/);
  if (!match) throw new Error('Mobile page has no ub98484234 signing function');
  if (match[0].length > 256 * 1024) throw new Error('Signing source exceeds 256 KiB');
  const source = match[0].replace(/eval.*?;}/g, 'strc;}');
  if (source === match[0]) throw new Error('Expected signing eval return did not match');
  const decoded = evalSandbox(`${source}\nub98484234();`, 'douyu-decode.js');
  const { value: inner, ...decodeEvidence } = decoded;
  result.sandbox.decode = { ...decodeEvidence, sourceBytes: Buffer.byteLength(source), decodedBytes: typeof inner === 'string' ? Buffer.byteLength(inner) : null };
  if (!decoded.ok || typeof inner !== 'string') throw new Error(`QuickJS decode failed: ${scrub(JSON.stringify(decoded.error))}`);
  await writePrivate('decoded-sign.js', inner);
  const version = inner.match(/v=(\d+)/)?.[1];
  if (!version) throw new Error('Decoded signing function has no v value');
  const did = '10000000000000000000000000001501';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  // The reference's exact input is known before execution. Precompute its MD5
  // rather than exposing Node crypto or any host callback to untrusted code.
  const md5 = createHash('md5').update(roomId + did + timestamp + version).digest('hex');
  const transformed = inner.replace(/return rt;}\);?/g, 'return rt;}')
    .replace(/\(function \(/g, 'function sign(')
    .replace(/CryptoJS\.MD5\(cb\)\.toString\(\)/g, JSON.stringify(md5));
  if (transformed.includes('CryptoJS.MD5')) throw new Error('Unexpected MD5 call remains after substitution');
  const sign = evalSandbox(`${transformed}\nsign(${JSON.stringify(roomId)},${JSON.stringify(did)},${JSON.stringify(timestamp)});`, 'douyu-sign.js');
  const { value: signed, ...signEvidence } = sign;
  result.sandbox.sign = { ...signEvidence, signedParamsBytes: typeof signed === 'string' ? Buffer.byteLength(signed) : null, version, md5Mode: 'host precomputed from known rid+did+timestamp+version; no host callback' };
  if (!sign.ok || typeof signed !== 'string') throw new Error(`QuickJS sign failed: ${scrub(JSON.stringify(sign.error))}`);
  if (signed.length > 8192) throw new Error('Signed params exceed 8 KiB');
  const params = new URLSearchParams(signed);
  params.set('ver', '219032101');
  params.set('rid', roomId);
  params.set('rate', '-1');
  result.sandbox.sign.paramKeys = [...params.keys()];
  await writePrivate('signed-params.txt', params.toString());
  return { roomId, params };
}

function summarizeRates(data) {
  return { returnedRate: Number.isFinite(Number(data?.rate)) ? Number(data.rate) : null,
    advertisedRates: (data?.settings || []).map(setting => Number(setting.rate)).filter(Number.isFinite) };
}

async function probeUrl(url, label) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Returned URL is not HTTP(S)');
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const args = ['-v', 'error'];
  if (proxy) args.push('-http_proxy', proxy);
  args.push('-rw_timeout', '15000000', '-read_intervals', '%+3', '-count_packets', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,bit_rate,nb_read_packets:format=format_name,duration', '-of', 'json', url);
  const start = performance.now();
  const child = spawn(ffprobe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { if (stdout.length < 128 * 1024) stdout += chunk; });
  child.stderr.on('data', chunk => { if (stderr.length < 32 * 1024) stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 30000);
  const exit = await new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolveExit({ code, signal }));
  }).finally(() => clearTimeout(timer));
  await writeFile(resolve(media, `${label}-ffprobe-stderr.txt`), scrub(stderr));
  let json;
  try { json = JSON.parse(stdout); } catch { json = {}; }
  const streams = json.streams || [];
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio');
  const playable = exit.code === 0 && Number(video?.nb_read_packets) > 0 && Number(audio?.nb_read_packets) > 0;
  const [fpsNumerator, fpsDenominator] = String(video?.r_frame_rate || '0/0').split('/').map(Number);
  const measured = { width: video?.width ?? null, height: video?.height ?? null,
    fps: fpsDenominator && Number.isFinite(fpsNumerator / fpsDenominator) ? fpsNumerator / fpsDenominator : null,
    rFrameRate: video?.r_frame_rate ?? null, avgFrameRate: video?.avg_frame_rate ?? null };
  await writeFile(resolve(media, `${label}-ffprobe-stdout.json`), JSON.stringify({ streams, format: json.format }));
  return { label, host: parsed.hostname, exit, elapsedMs: Number((performance.now() - start).toFixed(1)), playable, measured, streams, format: json.format, stderr: scrub(stderr) };
}

try {
  result.sandbox.noSystemInterfaces = evalSandbox('[typeof process,typeof require,typeof fetch,typeof XMLHttpRequest,typeof WebSocket,typeof console]', 'no-system.js');
  result.sandbox.infiniteLoop = evalSandbox('while(true){}', 'deadline-test.js');
  result.sandbox.memoryExhaustion = evalSandbox('new ArrayBuffer(32*1024*1024)', 'memory-test.js');
  if (result.sandbox.infiniteLoop.ok || result.sandbox.memoryExhaustion.ok) throw new Error('Sandbox resource limit test did not reject unsafe code');
  const roomId = await selectLiveRoom();
  const signed = await signedParams(roomId);
  const qualities = [{ rate: 0, name: 'Original' }, { rate: 3, name: 'Super clear' },
    { rate: 2, name: 'High' }, { rate: -1, name: 'Default' }];
  for (const setting of qualities) {
    const rateParams = new URLSearchParams(signed.params);
    rateParams.set('rate', String(setting.rate));
    let observation = { requestedRate: setting.rate, requestedName: setting.name, returnedRate: null };
    try {
      const rateApi = await fetchJson('https://m.douyu.com/api/room/ratestream', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `https://m.douyu.com/${signed.roomId}` }, body: rateParams.toString(),
      }, `ratestream-rate-${setting.rate}`);
      observation = { ...observation,
        returnedRate: rateApi.data?.rate ?? null, error: rateApi.error, code: rateApi.code,
        rates: summarizeRates(rateApi.data) };
      if ((rateApi.error === 0 || rateApi.code === 0) && rateApi.data?.url) {
        result.streams.push({ ...observation, ...await probeUrl(rateApi.data.url, `rate-${setting.rate}`) });
      } else {
        result.streams.push({ ...observation, playable: false, measured: null });
      }
    } catch (error) {
      result.streams.push({ ...observation, playable: false, measured: null, problem: scrub(error.message) });
    }
  }
  result.qualityObservation = result.streams.map(stream => ({ requestedRate: stream.requestedRate,
    returnedRate: stream.returnedRate, playable: stream.playable, measured: stream.measured }));
  result.qualityConclusion = 'Compare returned rates and ffprobe measurements; requested labels alone do not prove high quality or effective quality switching.';
  result.status = result.streams.every(stream => stream.playable) ? 'PASS' : 'PARTIAL';
  if (result.status !== 'PASS') result.problems.push('One or more requested rates did not yield measured audio and video packets');
} catch (error) {
  result.problems.push(scrub(error.message));
  result.status = result.sandbox.sign?.ok ? 'PARTIAL' : 'FAIL';
}
result.finishedAt = new Date().toISOString();
await writeFile(evidence, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.status === 'PASS' ? 0 : 1;
