import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { buildArgs } from './args.mjs';

const { values } = parseArgs({ options: {
  'runtime-dir': { type: 'string' }, 'work-dir': { type: 'string' },
  'fixtures-dir': { type: 'string' }, 'full-fixture-ffmpeg': { type: 'string' },
  openssl: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('node scripts/ffmpeg-smoke/run.mjs --runtime-dir <bin> --work-dir <new-runtime-cache-dir> --openssl <exe> (--fixtures-dir <media-dir> | --full-fixture-ffmpeg <exe>)');
  process.exit(0);
}
for (const option of ['runtime-dir', 'work-dir', 'openssl']) assert(values[option], `Missing --${option}`);
assert(Boolean(values['fixtures-dir']) !== Boolean(values['full-fixture-ffmpeg']), 'Choose exactly one fixture source');
assert.equal(process.platform, 'win32', 'Windows named-pipe smoke requires Windows');
const bin = path.resolve(values['runtime-dir']);
const out = path.resolve(values['work-dir']);
assert(/[\\/]\.runtime-cache[\\/]codex-ffmpeg-build-[^\\/]+(?:[\\/]|$)/i.test(out), 'Work directory must be a new .runtime-cache/codex-ffmpeg-build-* directory');
assert(!fs.existsSync(out), `Refusing to reuse existing work directory: ${out}`);
for (const exe of ['ffmpeg', 'ffprobe']) assert(fs.existsSync(path.join(bin, `${exe}.exe`)), `Missing ${exe}`);
const openssl = path.resolve(values.openssl);
assert(fs.existsSync(openssl), 'OpenSSL must be an existing explicit executable path');
fs.mkdirSync(out, { recursive: true });
const fixtures = path.join(out, 'fixtures');
fs.mkdirSync(fixtures);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(https?_proxy|all_proxy|no_proxy|path|appdata|localappdata|temp|tmp|home|userprofile|openssl_conf|openssl_modules)$/i.test(key))),
  PATH: `${bin};${process.env.SystemRoot || 'C:\\Windows'}\\System32`,
  APPDATA: out, LOCALAPPDATA: out, TEMP: out, TMP: out, USERPROFILE: out,
  http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '',
};
const checks = [];
const setup = [];
const tls = [];
const servers = [];
const sockets = new Set();
const requests = [];
const connects = [];
const tlsErrors = [];
let active = 'setup';

function json(name, value) { fs.writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 2)}\n`); }
function record(result, group) {
  group.push(result);
  json('results.json', { checks, tls, setup });
  console.log(JSON.stringify({ name: result.name, code: result.code, passed: result.passed, error: result.error }));
}
async function execute(name, exe, args, options = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      cwd: out, env: { ...env, ...options.env }, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [], stderr = [];
    let timedOut = false;
    let spawnError;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeout || 30000);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', () => {});
    if (options.stdin) {
      const stream = fs.createReadStream(options.stdin);
      stream.on('error', (error) => { spawnError = error.message; child.kill(); });
      child.on('close', () => stream.destroy());
      stream.pipe(child.stdin);
    } else child.stdin.end();
    child.on('error', (error) => { spawnError = error.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const so = Buffer.concat(stdout), se = Buffer.concat(stderr);
      fs.writeFileSync(path.join(out, `${name}.stdout`), so);
      fs.writeFileSync(path.join(out, `${name}.stderr`), se);
      resolve({ name, exe, args, code, signal, timedOut, seconds: (Date.now() - started) / 1000,
        stdout: so.toString(), stderr: se.toString(), ...(spawnError ? { error: spawnError } : {}) });
    });
  });
}
async function positive(name, exe, args, verify, options = {}, group = checks) {
  const result = await execute(name, exe, args, options);
  try {
    assert(!result.error, result.error);
    assert(!result.timedOut, 'Process timed out');
    assert.equal(result.signal, null);
    assert.equal(result.code, 0, result.stderr);
    if (verify) await verify(result);
    result.passed = true;
  } catch (error) { result.passed = false; result.error = error.message; }
  record(result, group);
  assert(result.passed, `${name}: ${result.error}`);
  return result;
}
function mediaPaths(root) {
  const files = ['official.mp4', 'av.ts', 'av.flv', 'video.mp4', 'audio.mp4', 'vp9.webm', 'av1.mp4'];
  for (const folder of ['gifframes', 'hls']) {
    assert(!fs.lstatSync(path.join(root, folder)).isSymbolicLink(), 'Fixture directories must not be symlinks');
    for (const name of fs.readdirSync(path.join(root, folder)).sort()) {
      assert(fs.statSync(path.join(root, folder, name)).isFile(), 'Fixture directories may only contain files');
      files.push(`${folder}/${name}`);
    }
  }
  return files.sort();
}
async function prepareFixtures() {
  if (values['fixtures-dir']) {
    const source = path.resolve(values['fixtures-dir']);
    for (const name of mediaPaths(source)) {
      const from = path.join(source, name), to = path.join(fixtures, name);
      assert(!fs.lstatSync(from).isSymbolicLink(), `Fixture must not be a symlink: ${name}`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    }
  } else {
    const full = path.resolve(values['full-fixture-ffmpeg']);
    assert(fs.existsSync(full), 'Missing fixture-generator FFmpeg');
    const run = (name, args) => positive(`fixture-${name}`, full, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], undefined, { timeout: 120000 }, setup);
    const av = path.join(fixtures, 'official.mp4');
    await run('av', ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', av]);
    await run('ts', ['-i', av, '-c', 'copy', '-f', 'mpegts', path.join(fixtures, 'av.ts')]);
    await run('flv', ['-i', av, '-c', 'copy', '-f', 'flv', path.join(fixtures, 'av.flv')]);
    await run('video', ['-i', av, '-map', '0:v:0', '-c', 'copy', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', path.join(fixtures, 'video.mp4')]);
    await run('audio', ['-i', av, '-map', '0:a:0', '-c', 'copy', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', path.join(fixtures, 'audio.mp4')]);
    await run('vp9', ['-i', av, '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-g', '20', path.join(fixtures, 'vp9.webm')]);
    await run('av1', ['-i', av, '-an', '-c:v', 'libaom-av1', '-cpu-used', '8', '-g', '20', '-crf', '45', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', path.join(fixtures, 'av1.mp4')]);
    fs.mkdirSync(path.join(fixtures, 'gifframes'));
    fs.mkdirSync(path.join(fixtures, 'hls'));
    await run('png', ['-i', av, '-vf', 'fps=5', '-frames:v', '10', path.join(fixtures, 'gifframes/frame-%04d.png')]);
    await run('hls', ['-i', av, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', path.join(fixtures, 'hls/segment-%03d.ts'), path.join(fixtures, 'hls/index.m3u8')]);
  }
  const inventory = mediaPaths(fixtures).map((name) => {
    const bytes = fs.readFileSync(path.join(fixtures, name));
    return { name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  for (const { name } of inventory.filter((entry) => entry.name.endsWith('.m3u8'))) {
    const playlist = fs.readFileSync(path.join(fixtures, name), 'utf8');
    const uris = playlist.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    uris.push(...[...playlist.matchAll(/URI="([^"]+)"/g)].map((match) => match[1]));
    for (const uri of uris) {
      assert(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(uri), `Fixture playlist URI must be a local basename: ${name}`);
      assert(fs.statSync(path.join(path.dirname(path.join(fixtures, name)), uri)).isFile(), 'Missing fixture playlist resource');
    }
  }
  json('fixtures.json', inventory);
}
function track(server) {
  servers.push(server);
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return server;
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
function probe(name, file, codecs) {
  return positive(`probe-${name}`, path.join(bin, 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', file], (result) => {
    const media = JSON.parse(result.stdout);
    const actual = media.streams.map((stream) => stream.codec_name).sort();
    assert.deepEqual(actual, [...codecs].sort());
    for (const stream of media.streams.filter((entry) => entry.width !== undefined)) {
      assert(stream.width > 0 && stream.height > 0, 'Video dimensions must be positive');
    }
  });
}
function gifFacts(file) {
  const data = fs.readFileSync(file);
  assert.equal(data.subarray(0, 6).toString(), 'GIF89a');
  assert.equal(data.readUInt16LE(6), 320);
  assert(data.readUInt16LE(8) > 0);
  let cursor = 13 + ((data[10] & 0x80) ? 3 * (1 << ((data[10] & 7) + 1)) : 0);
  let frames = 0;
  function blocks() {
    while (true) {
      assert(cursor < data.length, 'Truncated GIF sub-block');
      const size = data[cursor++];
      if (!size) break;
      cursor += size;
      assert(cursor <= data.length, 'GIF sub-block extends past EOF');
    }
  }
  while (cursor < data.length) {
    const marker = data[cursor++];
    if (marker === 0x3b) { assert.equal(cursor, data.length); break; }
    if (marker === 0x21) { cursor++; blocks(); continue; }
    assert.equal(marker, 0x2c, 'Unexpected GIF block');
    assert(cursor + 9 < data.length);
    assert(data.readUInt16LE(cursor + 4) > 0 && data.readUInt16LE(cursor + 6) > 0);
    const flags = data[cursor + 8]; cursor += 9;
    if (flags & 0x80) cursor += 3 * (1 << ((flags & 7) + 1));
    cursor++; blocks(); frames++;
  }
  assert(frames >= 2, 'GIF must contain multiple image frames');
  assert.equal(data[data.length - 1], 0x3b, 'Missing GIF trailer');
  return { magic: 'GIF89a', width: data.readUInt16LE(6), height: data.readUInt16LE(8), frames, size: data.length };
}
async function capabilities() {
  const server = track(http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).slice(1);
    const file = path.resolve(fixtures, relative);
    if (!file.startsWith(`${fixtures}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Length': fs.statSync(file).size, Connection: 'close' });
    fs.createReadStream(file).pipe(response);
  }));
  const port = await listen(server);
  await positive('version', path.join(bin, 'ffmpeg.exe'), ['-version'], (r) => assert.match(r.stdout, /^ffmpeg version \S+fy1sync\.1\b/m));
  await positive('license', path.join(bin, 'ffmpeg.exe'), ['-L'], (r) => {
    assert.match(r.stdout, /GNU Lesser General Public\s+License/);
    assert.match(r.stdout, /version 2\.1 of the License, or \(at your option\) any later version/);
  });
  await positive('tls-help', path.join(bin, 'ffmpeg.exe'), ['-hide_banner', '-h', 'protocol=tls'], (r) => {
    for (const option of ['tls_verify', 'verify']) assert.match(r.stdout, new RegExp(`^\\s*-${option}\\s+[^\\n]+\\(default true\\)`, 'm'));
  });
  await probe('source', path.join(fixtures, 'official.mp4'), ['h264', 'aac']);
  await positive('png-gif', path.join(bin, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-framerate', '5', '-i', path.join(fixtures, 'gifframes/frame-%04d.png'), '-filter_complex', '[0:v]scale=320:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer', '-loop', '0', path.join(out, 'result.gif')], () => json('gif.json', gifFacts(path.join(out, 'result.gif'))));
  for (const [name, file, fmp4] of [['ts', 'av.ts', false], ['flv', 'av.flv', false], ['hls', 'hls/index.m3u8', false], ['fmp4', 'av.ts', true]]) {
    const dir = path.join(out, name); fs.mkdirSync(dir);
    await positive(name, path.join(bin, 'ffmpeg.exe'), buildArgs({ url: `http://127.0.0.1:${port}/${file}` }, dir, 1, 'pipe:3', fmp4));
    await probe(name, path.join(dir, 'raw_1.m3u8'), ['h264', 'aac']);
  }
  for (const [name, file, videoContainer, codec] of [['adaptive-h264', 'video.mp4', 'mp4', 'h264'], ['adaptive-vp9', 'vp9.webm', 'webm', 'vp9'], ['adaptive-av1', 'av1.mp4', 'mp4', 'av1']]) {
    const dir = path.join(out, name); fs.mkdirSync(dir);
    const pipe = `\\\\.\\pipe\\stream-syncer-${crypto.randomUUID()}`;
    const pipeServer = net.createServer((socket) => {
      const source = fs.createReadStream(path.join(fixtures, 'audio.mp4'));
      source.on('error', () => socket.destroy()); socket.on('error', () => {});
      socket.on('close', () => source.destroy()); source.pipe(socket);
    });
    await new Promise((resolve, reject) => { pipeServer.once('error', reject); pipeServer.listen(pipe, resolve); });
    try { await positive(name, path.join(bin, 'ffmpeg.exe'), buildArgs({ adaptive: { videoContainer } }, dir, 2, pipe), undefined, { stdin: path.join(fixtures, file) }); }
    finally { pipeServer.close(); }
    await probe(name, path.join(dir, 'raw_2.m3u8'), [codec, 'aac']);
  }
  assert.equal(checks.length, 19);
}
async function tlsMatrix() {
  await positive('certificate', openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(out, 'key.pem'), '-out', path.join(out, 'cert.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], undefined, { env: { OPENSSL_CONF: 'NUL' } }, setup);
  const bytes = fs.readFileSync(path.join(fixtures, 'av.ts'));
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const iv = Buffer.alloc(16); iv[15] = 1;
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  let hp, sp;
  const playlist = (url, extra = '') => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:30\n#EXT-X-MEDIA-SEQUENCE:1\n${extra}#EXTINF:20,\n${url}\n#EXT-X-ENDLIST\n`;
  function serve(request, response) {
    const name = new URL(request.url, 'http://127.0.0.1').pathname;
    requests.push({ test: active, secure: Boolean(request.socket.encrypted), path: name });
    let data, type = 'application/vnd.apple.mpegurl';
    if (name === '/av.ts') { data = bytes; type = 'video/mp2t'; }
    else if (name === '/enc.ts') { data = encrypted; type = 'video/mp2t'; }
    else if (name === '/key.bin') { data = key; type = 'application/octet-stream'; }
    else if (name === '/master.m3u8') data = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nhttps://127.0.0.1:${sp}/child.m3u8\n`;
    else if (name === '/child.m3u8') data = playlist(`http://127.0.0.1:${hp}/av.ts`);
    else if (name === '/segments.m3u8') data = playlist(`https://127.0.0.1:${sp}/av.ts`);
    else if (name === '/keys.m3u8') data = playlist(`http://127.0.0.1:${hp}/enc.ts`, `#EXT-X-KEY:METHOD=AES-128,URI="https://127.0.0.1:${sp}/key.bin",IV=0x${iv.toString('hex')}\n`);
    else if (name === '/redirect.m3u8') data = playlist(`http://127.0.0.1:${hp}/redirect.ts`);
    else if (name === '/redirect.ts') { response.writeHead(302, { Location: `https://127.0.0.1:${sp}/av.ts` }).end(); return; }
    else { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data), Connection: 'close' }); response.end(data);
  }
  const h = track(http.createServer(serve)); hp = await listen(h);
  const s = track(https.createServer({ key: fs.readFileSync(path.join(out, 'key.pem')), cert: fs.readFileSync(path.join(out, 'cert.pem')) }, serve));
  s.on('tlsClientError', (error) => { tlsErrors.push({ test: active, message: error.message }); });
  sp = await listen(s);
  function allowed(url) { return url.hostname === '127.0.0.1' && [hp, sp].includes(Number(url.port)); }
  const p = track(http.createServer((request, response) => {
    let url;
    try { url = new URL(request.url); } catch { response.writeHead(400).end(); return; }
    if (url.protocol !== 'http:' || !allowed(url)) { response.writeHead(403).end(); return; }
    const headers = { ...request.headers }; delete headers['proxy-connection'];
    const upstream = http.request(url, { method: request.method, headers }, (result) => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
    upstream.on('error', () => response.writeHead(502).end()); request.pipe(upstream);
  }));
  p.on('connect', (request, client, head) => {
    const url = new URL(`http://${request.url}`);
    if (!allowed(url)) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    connects.push({ test: active, target: request.url });
    const upstream = net.connect(Number(url.port), url.hostname, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
  });
  const pp = await listen(p);
  for (const proxy of [false, true]) {
    for (const [kind, url, parent] of [
      ['entry', `https://127.0.0.1:${sp}/av.ts`, null],
      ['playlist', `http://127.0.0.1:${hp}/master.m3u8`, '/master.m3u8'],
      ['segment', `http://127.0.0.1:${hp}/segments.m3u8`, '/segments.m3u8'],
      ['key', `http://127.0.0.1:${hp}/keys.m3u8`, '/keys.m3u8'],
      ['redirect', `http://127.0.0.1:${hp}/redirect.m3u8`, '/redirect.ts'],
    ]) {
      const name = `tls-${proxy ? 'proxy' : 'direct'}-${kind}`;
      active = name; const requestStart = requests.length, connectStart = connects.length, tlsErrorStart = tlsErrors.length;
      const dir = path.join(out, name); fs.mkdirSync(dir);
      const result = await execute(name, path.join(bin, 'ffmpeg.exe'), buildArgs({ url }, dir, 1), { env: { http_proxy: proxy ? `http://127.0.0.1:${pp}` : '' } });
      // The server error may arrive just after the client process closes.
      for (let attempt = 0; attempt < 20 && tlsErrors.length === tlsErrorStart; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      result.requests = requests.slice(requestStart); result.connects = connects.slice(connectStart);
      result.serverTlsErrors = tlsErrors.slice(tlsErrorStart).filter((entry) => entry.test === name);
      try {
        assert(!result.error, result.error); assert(!result.timedOut, 'Process timed out'); assert.equal(result.signal, null);
        assert.notEqual(result.code, 0, 'Untrusted TLS input must fail');
        assert.match(result.stderr, /certificate|0x80090325|0x80090322|SNI or certificate check failed/i);
        assert(result.serverTlsErrors.length > 0, 'HTTPS server did not observe a failed TLS handshake');
        assert.equal(result.requests.filter((entry) => entry.secure).length, 0, 'Untrusted HTTPS received an HTTP request');
        if (parent) assert(result.requests.some((entry) => entry.path === parent), 'Parent HTTP request was not reached');
        assert.equal(result.connects.length, proxy ? 1 : 0, 'Unexpected CONNECT count');
        if (proxy) assert.equal(result.connects[0].target, `127.0.0.1:${sp}`);
        result.passed = true;
      } catch (error) { result.passed = false; result.error = error.message; }
      record(result, tls);
    }
    active = `http-${proxy ? 'proxy' : 'direct'}-control`;
    const dir = path.join(out, active); fs.mkdirSync(dir);
    await positive(active, path.join(bin, 'ffmpeg.exe'), buildArgs({ url: `http://127.0.0.1:${hp}/child.m3u8` }, dir, 1), () => {
      assert(fs.statSync(path.join(dir, 'raw_1.m3u8')).size > 0);
    }, { env: { http_proxy: proxy ? `http://127.0.0.1:${pp}` : '' } }, tls);
  }
  json('network.json', { requests, connects, tlsErrors });
  assert.equal(tls.filter((entry) => entry.name.startsWith('tls-')).length, 10);
  assert(tls.every((entry) => entry.passed), 'One or more TLS cases failed');
  assert.equal(requests.filter((entry) => entry.secure).length, 0);
}
try {
  await prepareFixtures();
  await capabilities();
  await tlsMatrix();
  json('summary.json', { passed: true, capabilityChecks: checks.length, tlsNegativeChecks: 10, httpControls: 2,
    httpsRequests: requests.filter((entry) => entry.secure).length, gif: gifFacts(path.join(out, 'result.gif')) });
} catch (error) {
  json('summary.json', { passed: false, error: error.message, capabilityChecks: checks.length, tlsChecks: tls.length });
  console.error(error.stack); process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
}
