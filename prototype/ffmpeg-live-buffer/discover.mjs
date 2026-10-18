import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ytdlp = process.env.YTDLP_PATH || '<home>\\AppData\\Local\\Python\\pythoncore-3.14-64\\Scripts\\yt-dlp.exe';
const args = ['--ignore-config', '--cache-dir', path.join(root, '.media', 'youtube-hls', 'ytdlp-cache'), '--flat-playlist', '--dump-single-json', '--socket-timeout', '20', '--retries', '1', 'ytsearch10:live news 24/7'];
const result = await new Promise((resolve, reject) => {
  const child = spawn(ytdlp, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', reject);
  child.on('close', code => resolve({ code, stdout, stderr }));
});
await mkdir(path.join(root, '.media', 'youtube-hls'), { recursive: true });
await mkdir(path.join(root, '.evidence'), { recursive: true });
await writeFile(path.join(root, '.media', 'youtube-hls', 'search-private.json'), result.stdout);
await writeFile(path.join(root, '.media', 'youtube-hls', 'search-private.log'), result.stderr);
const data = JSON.parse(result.stdout);
const evidence = { observedAt: new Date().toISOString(), command: [ytdlp, ...args], exitCode: result.code,
  entries: data.entries.map(entry => ({ id: entry.id, title: entry.title, liveStatus: entry.live_status ?? null })),
  stderr: result.stderr.replace(/https?:\/\/[^\s"'<>]+/g, '<remote URL>') };
await writeFile(path.join(root, '.evidence', 'youtube-search.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
process.exitCode = result.code;
