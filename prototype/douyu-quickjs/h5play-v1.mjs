// P0b: Douyu quality switching through the PC getH5PlayV1 endpoint.
//
// Unlike the mobile ratestream path, this needs no remote JavaScript at all: the server
// hands out an encryption seed (getEncryption) and the auth token is plain iterated MD5.
// Flow per streamlink PR #6959 and renmu123/biliLive-tools StreamGet (2026).
//
// Run: P0_COOKIES=<douyu cookie file> NODE_USE_ENV_PROXY=1 node douyu-quickjs/h5play-v1.mjs
// Never prints cookie values or signed stream URLs.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const evidence = resolve(here, '..', '.evidence', 'douyu-h5play-v1.json');
const ffprobe = process.env.P0_FFPROBE || '<home>\\Desktop\\ffmpeg\\bin\\ffprobe.exe';
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const md5 = text => createHash('md5').update(text).digest('hex');

const cookies = require('../login/cookies.cjs').createCookieContext();
const result = { startedAt: new Date().toISOString(), cookiesEnabled: cookies.enabled, room: null, did: null, multirates: null, observations: [], problems: [] };

async function http(url, options = {}) {
  const cookie = cookies.headerFor(url);
  const response = await fetch(url, {
    ...options,
    headers: { 'User-Agent': ua, Referer: 'https://www.douyu.com/', ...options.headers, ...(cookie ? { Cookie: cookie } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(text);
}

function buildAuth(roomId, timestamp, enc) {
  const input = enc.is_special === 1 ? '' : `${roomId}${timestamp}`;
  let seed = enc.rand_str;
  for (let index = 0; index < enc.enc_time; index += 1) seed = md5(seed + enc.key);
  return md5(seed + enc.key + input);
}

function probe(url) {
  return new Promise(resolvePromise => {
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const args = ['-v', 'error', ...(proxy ? ['-http_proxy', proxy] : []), '-rw_timeout', '15000000', '-read_intervals', '%+3',
      '-count_packets', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_packets', '-of', 'json', url];
    const child = spawn(ffprobe, args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('close', code => {
      try {
        const streams = JSON.parse(out).streams || [];
        const video = streams.find(stream => stream.codec_type === 'video');
        const [n, d] = String(video?.r_frame_rate || '0/1').split('/').map(Number);
        resolvePromise({ exit: code, codec: video?.codec_name ?? null, width: video?.width ?? null, height: video?.height ?? null, fps: d ? Math.round(n / d) : null,
          videoPackets: Number(video?.nb_read_packets || 0) });
      } catch { resolvePromise({ exit: code, codec: null, width: null, height: null, fps: null, videoPackets: 0 }); }
    });
  });
}

try {
  const roomId = process.env.P0_DOUYU_ROOM || '9999';
  if (!/^\d{1,9}$/.test(roomId)) throw new Error('P0_DOUYU_ROOM must be numeric');
  result.room = roomId;
  // A logged-in browser carries its own device id; the anonymous default otherwise.
  const didCookie = cookies.enabled ? (cookies.headerFor('https://www.douyu.com/').match(/(?:^|; )dy_did=([0-9a-f]{32})/) || [])[1] : null;
  const did = didCookie || '10000000000000000000000000001501';
  result.did = didCookie ? 'from-cookie' : 'default';

  const encryption = await http(`https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption?did=${did}`);
  if (encryption.error !== 0 || !encryption.data) throw new Error(`getEncryption error ${encryption.error}`);

  for (const rate of [0, 4, 3, 2, 1]) {
    // A fresh timestamp per request, and auth computed from that same timestamp:
    // streamlink found a tt/auth mismatch to be the cause of intermittent 403s.
    const timestamp = Math.round(Date.now() / 1000);
    const body = new URLSearchParams({
      enc_data: encryption.data.enc_data, tt: String(timestamp), did,
      auth: buildAuth(roomId, timestamp, encryption.data),
      cdn: '', rate: String(rate), hevc: '0', fa: '0', ive: '0',
    });
    const observation = { requestedRate: rate };
    try {
      const play = await http(`https://www.douyu.com/lapi/live/getH5PlayV1/${roomId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
      });
      observation.error = play.error;
      if (play.error === 0 && play.data) {
        if (!result.multirates) result.multirates = (play.data.multirates || []).map(item => ({ name: item.name, rate: item.rate, bit: item.bit, highBit: item.highBit }));
        observation.returnedRate = play.data.rate;
        // Bitrate tag in the stream name, e.g. ..._4000p.flv, without the signed query.
        observation.streamTag = (String(play.data.rtmp_live).match(/_(\d+p)\./) || [])[1] || 'source';
        observation.format = /\.m3u8/.test(play.data.rtmp_live) ? 'hls' : 'flv';
        observation.probe = await probe(`${play.data.rtmp_url}/${play.data.rtmp_live}`);
      } else {
        observation.message = String(play.msg || '').slice(0, 80);
      }
    } catch (error) {
      observation.message = cookies.diagnostics(error.message);
    }
    result.observations.push(observation);
  }
} catch (error) {
  result.problems.push(cookies.diagnostics(error.message));
}

result.finishedAt = new Date().toISOString();
await writeFile(evidence, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ room: result.room, did: result.did, multirates: result.multirates, problems: result.problems }, null, 1));
for (const o of result.observations) {
  console.log(`rate ${String(o.requestedRate).padStart(2)} -> returned ${o.returnedRate ?? '-'} tag=${o.streamTag ?? '-'} ${o.format ?? ''} ` +
    (o.probe ? `${o.probe.codec} ${o.probe.width}x${o.probe.height}@${o.probe.fps} packets=${o.probe.videoPackets}` : `error=${o.error ?? '-'} ${o.message ?? ''}`));
}
