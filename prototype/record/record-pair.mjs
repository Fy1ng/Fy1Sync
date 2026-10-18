// Records an official YouTube live and a Douyu commentary live side by side, stream copy only,
// as P4 test material. Writes into prototype/.media/<stamp>/ (gitignored) plus a meta.json with
// wall-clock start times. Never prints cookie values or signed stream URLs.
//
// Run: P0_COOKIES=.runtime/cookies/douyu.txt YT_COOKIES=.runtime/cookies/youtube.txt \
//      YT_ID=<video id> DOUYU_ROOM=<numeric room> SECONDS=480 node record/record-pair.mjs
// Douyu only: YT_MODE=none P0_COOKIES=.runtime/cookies/douyu.txt DOUYU_ROOM=<room> node record/record-pair.mjs

import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const ffmpeg = process.env.P0_FFMPEG || '<home>/Desktop/ffmpeg/bin/ffmpeg.exe';
const ytdlp = join(root, '.runtime', 'yt-dlp', 'yt-dlp.exe');
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const md5 = text => createHash('md5').update(text).digest('hex');
const seconds = Number(process.env.SECONDS || 480);
const ytId = process.env.YT_ID, room = process.env.DOUYU_ROOM;
// YT_MODE=none records only Douyu (YT_ID / YT_COOKIES not needed); any other value keeps both.
const withYoutube = process.env.YT_MODE !== 'none';
if ((withYoutube && !/^[\w-]{11}$/.test(ytId || '')) || !/^\d{1,9}$/.test(room || '') || !(seconds > 0 && seconds <= 3600)) throw new Error('YT_ID, DOUYU_ROOM, SECONDS invalid');

const cookies = require('../login/cookies.cjs').createCookieContext();
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

async function http(url, options = {}) {
  const cookie = cookies.headerFor(url);
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': ua, Referer: 'https://www.douyu.com/', ...options.headers, ...(cookie ? { Cookie: cookie } : {}) } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function douyuUrl() {
  const did = (cookies.headerFor('https://www.douyu.com/').match(/(?:^|; )dy_did=([0-9a-f]{32})/) || [])[1] || '10000000000000000000000000001501';
  const enc = (await http(`https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption?did=${did}`)).data;
  const tt = Math.round(Date.now() / 1000);
  let seed = enc.rand_str;
  for (let i = 0; i < enc.enc_time; i += 1) seed = md5(seed + enc.key);
  const auth = md5(seed + enc.key + (enc.is_special === 1 ? '' : `${room}${tt}`));
  const body = new URLSearchParams({ enc_data: enc.enc_data, tt: String(tt), did, auth, cdn: '', rate: '0', hevc: '0', fa: '0', ive: '0' });
  const play = await http(`https://www.douyu.com/lapi/live/getH5PlayV1/${room}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  if (play.error !== 0) throw new Error(`getH5PlayV1 error ${play.error}`);
  return { url: `${play.data.rtmp_url}/${play.data.rtmp_live}`, rate: play.data.rate, rates: (play.data.multirates || []).map(r => `${r.rate}:${r.name}`) };
}

function youtubeUrl() {
  // yt-dlp may rewrite the cookie jar, so it only ever sees a private temporary copy.
  const tmp = join(os.tmpdir(), `rec-yt-${process.pid}.txt`);
  copyFileSync(resolve(process.env.YT_COOKIES), tmp);
  return new Promise((ok, fail) => execFile(ytdlp, ['--cookies', tmp, '--js-runtimes', 'node', '-f', '301/300/best', '-g', `https://www.youtube.com/watch?v=${ytId}`],
    { windowsHide: true, timeout: 120000 }, (error, stdout) => {
      rmSync(tmp, { force: true });
      error ? fail(new Error('yt-dlp failed')) : ok(stdout.trim().split(/\r?\n/)[0]);
    }));
}

function record(url, file, headers) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(proxy ? ['-http_proxy', proxy] : []),
    '-rw_timeout', '15000000', ...(headers ? ['-headers', headers] : []), '-i', url, '-t', String(seconds), '-c', 'copy', '-f', 'mpegts', file];
  const started = Date.now();
  const child = spawn(ffmpeg, args, { windowsHide: true });
  child.on('error', error => { console.error(`ffmpeg spawn failed: ${error.code}`); process.exit(1); });
  let errors = 0;
  child.stderr.on('data', () => { errors += 1; });
  return new Promise(ok => child.on('close', code => ok({ code, started, ended: Date.now(), stderrChunks: errors })));
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = join(root, '.media', stamp);
mkdirSync(out, { recursive: true });
const [yt, dy] = await Promise.all([withYoutube ? youtubeUrl() : null, douyuUrl()]);
console.log(`resolved; douyu rate ${dy.rate} of [${dy.rates.join(', ')}]; recording ${seconds}s into ${out}`);
const [ytResult, dyResult] = await Promise.all([
  withYoutube ? record(yt, join(out, 'official-youtube.ts')) : null,
  record(dy.url, join(out, 'commentary-douyu.ts'), `Referer: https://www.douyu.com/\r\nUser-Agent: ${ua}\r\n`),
]);
const meta = { youtube: withYoutube ? { id: ytId, ...ytResult } : null, douyu: { room, rate: dy.rate, ...dyResult }, seconds };
writeFileSync(join(out, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
console.log(JSON.stringify(meta));
