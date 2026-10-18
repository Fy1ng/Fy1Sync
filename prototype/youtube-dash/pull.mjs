// P0c: pull a YouTube live adaptive (video-only + audio-only) pair segment by segment using the
// `sq` index, the way the web player does, and check it stays 200 for the whole run.
// Input: a file with two lines (video URL, audio URL) from `yt-dlp -g -f V+A`. Writes segments
// to OUT_DIR, plus a summary JSON. Never prints signed URLs.
//
// Run: URLS=<file> OUT_DIR=<dir> SECONDS=330 NODE_USE_ENV_PROXY=1 node youtube-dash/pull.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [video, audio] = readFileSync(process.env.URLS, 'utf8').trim().split(/\r?\n/);
const out = process.env.OUT_DIR, seconds = Number(process.env.SECONDS || 330);
if (!video?.startsWith('https://') || !audio?.startsWith('https://') || !out) throw new Error('URLS / OUT_DIR invalid');
mkdirSync(out, { recursive: true });

const summary = { started: Date.now(), segments: 0, bytes: { video: 0, audio: 0 }, statuses: {}, retries: 0, gaps: 0, headLag: [] };
const bump = status => { summary.statuses[status] = (summary.statuses[status] || 0) + 1; };

async function fetchSegment(base, sq) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${base}&sq=${sq}`, { signal: AbortSignal.timeout(20000) }).catch(() => null);
    const status = response?.status ?? 'network';
    bump(status);
    if (response?.ok) return { body: Buffer.from(await response.arrayBuffer()), head: Number(response.headers.get('x-head-seqnum')) };
    summary.retries += 1;
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  return null;
}

const first = await fetchSegment(video, 0);
if (!first) throw new Error('could not read head sequence');
let sq = first.head - 2;
summary.firstSq = sq;
const deadline = Date.now() + seconds * 1000;
while (Date.now() < deadline) {
  const [v, a] = await Promise.all([fetchSegment(video, sq), fetchSegment(audio, sq)]);
  if (!v || !a) { summary.gaps += 1; sq += 1; continue; }
  writeFileSync(join(out, `v_${sq}.webm`), v.body);
  writeFileSync(join(out, `a_${sq}.mp4`), a.body);
  summary.segments += 1; summary.bytes.video += v.body.length; summary.bytes.audio += a.body.length;
  summary.headLag.push(v.head - sq);
  sq += 1;
  // Stay ~2 segments behind the live head; wait when caught up.
  if (v.head - sq < 1) await new Promise(resolve => setTimeout(resolve, 2500));
}
summary.lastSq = sq - 1;
summary.ended = Date.now();
summary.maxHeadLag = Math.max(...summary.headLag); delete summary.headLag;
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
