import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieTools from '../login/cookies.cjs';

let cookies;
try { cookies = cookieTools.createCookieContext(); }
catch { console.error('P0_COOKIES must be a valid Netscape cookie file inside prototype/.runtime/'); process.exit(1); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const media = path.join(root, '.media', 'youtube-hls');
const dashMedia = path.join(root, '.media', 'youtube-dash');
const evidencePath = path.join(root, '.evidence', 'youtube-buffer.json');
const ytdlp = process.env.YTDLP_PATH || '<home>\\AppData\\Local\\Python\\pythoncore-3.14-64\\Scripts\\yt-dlp.exe';
const ffmpeg = process.env.FFMPEG_PATH || '<home>\\Desktop\\ffmpeg\\bin\\ffmpeg.exe';
const ffprobe = ffmpeg.replace(/ffmpeg\.exe$/i, 'ffprobe.exe');
const seconds = Number(process.env.BUFFER_SECONDS || 310);
const runtime = process.env.YTDLP_NODE_RUNTIME || process.execPath;
const candidates = process.env.YOUTUBE_LIVE_URL ? [process.env.YOUTUBE_LIVE_URL] : [
  'https://www.youtube.com/watch?v=-PWMxjBgr0k',
  'https://www.youtube.com/watch?v=C96oohpWBGw',
  'https://www.youtube.com/watch?v=z0_NKzi57Fo',
  'https://www.youtube.com/watch?v=jfKfPfyJRdk',
  'https://www.youtube.com/@lofigirl/live',
  'https://www.youtube.com/@DWNews/live',
];
const evidence = { startedAt: new Date().toISOString(), status: 'PARTIAL', cookiesEnabled: cookies.enabled, ytdlpVersion: null, attempts: [], formats: [], hls: null, dash: null };
const safe = (s) => cookies.diagnostics(s).replace(/https?:\/\/[^\s"'<>]+/g, '<remote URL>');
function classify(stderr) {
  if (/not a bot|bot\./i.test(stderr)) return 'youtube_authentication_required';
  if (/recording is not available|not currently live|not live/i.test(stderr)) return 'live_unavailable';
  if (/timed out|network|SSL|certificate|connection|HTTP Error/i.test(stderr)) return 'network_or_http_failure';
  if (/JavaScript runtime|JS runtime|challenge solving|signature solving/i.test(stderr)) return 'javascript_challenge_runtime';
  return 'unclassified_extractor_failure';
}
const log = (s) => process.stdout.write(`${s}\n`);
const persist = async () => writeFile(evidencePath, JSON.stringify(evidence, null, 2));

async function capture(bin, args, timeout = 120_000, env = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...env } });
    let stdout = '', stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, stdout, stderr }); });
  });
}

function describe(f) {
  return {
    id: f.format_id, protocol: f.protocol, ext: f.ext, width: f.width ?? null, height: f.height ?? null,
    fps: f.fps ?? null, vcodec: f.vcodec ?? null, acodec: f.acodec ?? null,
    tbrKbps: f.tbr ?? null, vbrKbps: f.vbr ?? null, abrKbps: f.abr ?? null,
    hasManifest: Boolean(f.manifest_url), hasFragments: Boolean(f.fragments?.length), fragmentCount: f.fragments?.length ?? 0,
    formatNote: f.format_note ?? null,
  };
}

async function playlistStats(directory) {
  let text = '';
  try { text = await readFile(path.join(directory, 'index.m3u8'), 'utf8'); } catch { return null; }
  const durations = Array.from(text.matchAll(/#EXTINF:([\d.]+)/g), m => Number(m[1]));
  const files = (await readdir(directory)).filter(f => /\.ts$/.test(f));
  const sequence = Number(text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] ?? 0);
  const listed = text.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  return { durationSeconds: durations.reduce((a, b) => a + b, 0), segmentDurationMin: durations.length ? Math.min(...durations) : null, segmentDurationMax: durations.length ? Math.max(...durations) : null, listedSegments: listed.length, filesOnDisk: files.length, sequence, firstSegment: listed[0], lastSegment: listed.at(-1), endList: text.includes('#EXT-X-ENDLIST') };
}

async function bufferHls(input, directory, duration, prefix, inputArgs = [], maps = []) {
  const playlist = path.join(directory, 'index.m3u8');
  const args = ['-hide_banner', '-y', '-rw_timeout', '20000000', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10', ...inputArgs, '-i', input, ...maps,
    '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '90',
    '-hls_flags', 'delete_segments+append_list+program_date_time', '-hls_delete_threshold', '1',
    '-hls_segment_filename', path.join(directory, 'segment_%06d.ts'), playlist];
  const started = Date.now();
  const child = spawn(ffmpeg, args, { windowsHide: true });
  let stderr = '', exited = false, exitCode = null;
  let resolveClose;
  const closed = new Promise(resolve => { resolveClose = resolve; });
  child.stderr.on('data', d => { stderr += d; });
  child.on('error', err => { stderr += err.stack; });
  child.on('close', code => { exited = true; exitCode = code; resolveClose(); });
  const checkpoints = [];
  while (!exited && Date.now() - started < duration * 1000) {
    await new Promise(resolve => setTimeout(resolve, 10_000));
    const wallSeconds = (Date.now() - started) / 1000;
    const stats = await playlistStats(directory);
    checkpoints.push({ wallSeconds, ...stats });
    log(`${prefix} ${wallSeconds.toFixed(1)}s ${JSON.stringify(stats)}`);
  }
  if (!exited) {
    child.stdin.write('q\n');
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 10_000))]);
    if (!exited) child.kill();
  }
  await closed;
  await writeFile(path.join(directory, 'ffmpeg-private.log'), safe(stderr));
  const wallSeconds = (Date.now() - started) / 1000;
  const stats = await playlistStats(directory);
  const probe = stats ? await capture(ffprobe, ['-v', 'error', '-analyzeduration', '10000000', '-probesize', '10000000', '-show_entries', 'format=duration:stream=index,codec_name,codec_type,width,height,r_frame_rate,bit_rate', '-of', 'json', playlist], 60_000) : null;
  const result = { wallSeconds, exitCode, stoppedAfterRequestedDuration: wallSeconds >= duration, playlistRelative: path.relative(path.join(root, '.media'), playlist).replaceAll('\\', '/'), command: [ffmpeg, ...args.map(a => a === input ? `<${prefix} resolved URL>` : a)], final: stats, checkpoints,
    ffprobe: probe ? { code: probe.code, timedOut: probe.timedOut, output: (() => { try { return JSON.parse(probe.stdout); } catch { return safe(probe.stdout); } })(), stderr: safe(probe.stderr) } : null,
    ffmpegTail: safe(stderr.split(/\r?\n/).filter(Boolean).slice(-20).join('\n')) };
  return result;
}

async function main() {
await Promise.all([mkdir(media, { recursive: true }), mkdir(dashMedia, { recursive: true }), mkdir(path.dirname(evidencePath), { recursive: true })]);
try { const previous = JSON.parse(await readFile(evidencePath, 'utf8')); evidence.attempts = previous.attempts ?? []; evidence.startedAt = previous.startedAt ?? evidence.startedAt; } catch {}
const version = await capture(ytdlp, ['--version']);
evidence.ytdlpVersion = version.stdout.trim();
log(`yt-dlp=${evidence.ytdlpVersion}, node runtime=${runtime}`);
let info;
for (const url of candidates) {
  const args = ['--ignore-config', '--cache-dir', path.join(media, 'ytdlp-cache'), '--no-playlist', '--no-progress', '--socket-timeout', '20', '--retries', '1', '--extractor-retries', '1', '--no-js-runtimes', '--js-runtimes', `node:${runtime}`, '--dump-single-json', url];
  if (process.env.YTDLP_EXTRACTOR_ARGS) args.splice(-1, 0, '--extractor-args', process.env.YTDLP_EXTRACTOR_ARGS);
  const env = /electron\.exe$/i.test(runtime) ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  const result = await cookies.withYtdlpCookies(async cookieArgs => {
    try { return await capture(ytdlp, [...cookieArgs, ...args], 180_000, env); }
    catch { throw new Error('yt-dlp launch or temporary cookie setup failed'); }
  });
  await writeFile(path.join(media, `resolve-${evidence.attempts.length + 1}-private.log`), safe(result.stderr));
  evidence.attempts.push({ publicUrl: url, command: [ytdlp, ...(cookies.enabled ? ['--cookies', '<temporary cookie file under .runtime/cookies>'] : []), ...args], ytdlpVersion: evidence.ytdlpVersion, exitCode: result.code, timedOut: result.timedOut, classification: result.code === 0 ? 'resolved' : classify(result.stderr), stderr: safe(result.stderr) });
  try { info = JSON.parse(result.stdout); } catch { info = null; }
  log(`resolve ${url}: exit=${result.code}, live=${info?.is_live}, formats=${info?.formats?.length ?? 0}, ${safe(result.stderr).trim().slice(0, 1200)}`);
  await persist();
  if (result.code === 0 && info?.is_live && info.formats?.length) break;
  info = null;
}
if (!info) {
  evidence.status = 'FAIL';
  evidence.problem = 'No currently live URL successfully resolved. See classified attempts.';
  evidence.blockedMetrics = { offeredFormats: 0, ffmpegWallSeconds: 0, bufferDurationSeconds: 0, segments: 0, playbackSeekBack120Seconds: 'not run; no resolved live media URL', dashPairMux: 'not run; no offered formats' };
  evidence.finishedAt = new Date().toISOString();
  await persist();
  process.exitCode = 1;
} else {
  // yt-dlp metadata may include authenticated HTTP headers. Never persist it
  // outside the runtime cookie directory when using a logged-in session.
  await writeFile(path.join(media, 'metadata-private.json'), cookies.enabled ? JSON.stringify({ omitted: 'Authenticated metadata is kept in memory only' }) : JSON.stringify(info));
  evidence.live = { id: info.id, title: info.title, channel: info.channel, isLive: info.is_live, liveStatus: info.live_status };
  evidence.formats = info.formats.map(describe);
  const hlsFormats = info.formats.filter(f => /m3u8/.test(f.protocol ?? '') && f.url);
  const dashFormats = info.formats.filter(f => /dash/.test(f.protocol ?? '') || (f.manifest_url && /\.mpd(?:\?|$)/i.test(f.manifest_url)));
  const rank = (a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.fps ?? 0) - (a.fps ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0);
  hlsFormats.sort(rank); dashFormats.sort(rank);
  const dashAudioFormats = [...dashFormats].filter(f => f.acodec && f.acodec !== 'none' && f.vcodec === 'none').sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0));
  evidence.hlsMaximum = hlsFormats[0] ? describe(hlsFormats[0]) : null;
  evidence.dashMaximum = dashFormats[0] ? describe(dashFormats[0]) : null;
  evidence.dashAudioMaximum = dashAudioFormats[0] ? describe(dashAudioFormats[0]) : null;
  evidence.dashOfferedCount = dashFormats.length;
  log(`formats ${JSON.stringify(evidence.formats)}`);
  await persist();
  if (!hlsFormats.length) {
    evidence.problem = 'Resolved live, but yt-dlp offered no HLS format.';
  } else {
    const selected = hlsFormats.find(f => /avc1|h264/.test(f.vcodec ?? '') && f.acodec !== 'none') ?? hlsFormats[0];
    evidence.hlsSelected = describe(selected);
    log(`HLS selected ${JSON.stringify(evidence.hlsSelected)}; collecting ${seconds}s`);
    evidence.hls = await bufferHls(selected.url, media, seconds, 'HLS', ['-live_start_index', '-3']);
    await persist();
  }
  const video = dashFormats.find(f => /avc1|h264/.test(f.vcodec ?? '') && f.vcodec !== 'none') ?? dashFormats.find(f => f.vcodec && f.vcodec !== 'none');
  const audio = dashFormats.find(f => /mp4a|aac/.test(f.acodec ?? '') && f.vcodec === 'none') ?? dashFormats.find(f => f.acodec && f.acodec !== 'none' && f.vcodec === 'none');
  if (video && audio && (video.manifest_url || video.url)) {
    // A live DASH MPD is the reproducible ffmpeg input; yt-dlp's fragment URLs alone are not MPD inputs.
    const manifest = video.manifest_url;
    if (manifest) {
      const manifestProbe = await capture(ffprobe, ['-v', 'error', '-rw_timeout', '20000000', '-show_entries', 'stream=index,id,codec_name,codec_type,width,height,r_frame_rate,bit_rate', '-of', 'json', manifest], 60_000);
      let streams = [];
      try { streams = JSON.parse(manifestProbe.stdout).streams ?? []; } catch {}
      const expectedVCodec = /avc1|h264/.test(video.vcodec) ? 'h264' : /vp9/.test(video.vcodec) ? 'vp9' : /av01|av1/.test(video.vcodec) ? 'av1' : null;
      const expectedACodec = /mp4a|aac/.test(audio.acodec) ? 'aac' : /opus/.test(audio.acodec) ? 'opus' : null;
      const vStream = streams.find(s => s.codec_type === 'video' && s.height === video.height && (!expectedVCodec || s.codec_name === expectedVCodec));
      const aStream = streams.find(s => s.codec_type === 'audio' && (!expectedACodec || s.codec_name === expectedACodec));
      evidence.dashSelected = { video: describe(video), audio: describe(audio), source: 'DASH MPD manifest', ffprobeExitCode: manifestProbe.code, availableStreams: streams, mappedVideoIndex: vStream?.index ?? null, mappedAudioIndex: aStream?.index ?? null };
      if (vStream && aStream) {
        evidence.dash = await bufferHls(manifest, dashMedia, 30, 'DASH', [], ['-map', `0:${vStream.index}`, '-map', `0:${aStream.index}`]);
      } else {
        evidence.dash = { status: 'FAIL', problem: 'ffprobe did not find both selected DASH representations in the MPD.', ffprobeExitCode: manifestProbe.code, stderr: safe(manifestProbe.stderr) };
      }
    } else {
      evidence.dash = { status: 'PARTIAL', problem: 'DASH formats contain fragments, but no MPD manifest URL that ffmpeg can consume.' };
    }
  } else {
    evidence.dash = { status: 'PARTIAL', problem: 'yt-dlp did not offer a DASH video+audio pair for the resolved live with its current client selection.' };
  }
  evidence.status = evidence.hls?.wallSeconds >= 300 && evidence.hls?.final?.durationSeconds >= 120 && evidence.hls?.ffprobe?.code === 0 ? 'PARTIAL' : 'FAIL';
  evidence.problem = evidence.problem ?? 'Main-process Electron playback and seek-back 120s are verified separately by the playback prototype.';
  evidence.finishedAt = new Date().toISOString();
  await persist();
  log(`DONE ${evidence.status}; evidence=${evidencePath}; playlist=${evidence.hls?.playlistRelative}`);
}
}

main().catch(() => {
  console.error('Live buffer validation failed. Check executable paths, P0_COOKIES and runtime file permissions.');
  process.exitCode = 1;
});
