const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ffmpeg = process.env.FFMPEG || '<home>\\Desktop\\ffmpeg\\bin\\ffmpeg.exe';
async function run(name, source) {
  const dir = path.join(root, '.media', name);
  fs.mkdirSync(dir, { recursive: true });
  const args = ['-hide_banner', '-y', '-f', 'lavfi', '-i', `${source}=size=1920x1080:rate=60`, '-t', '120', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '4', '-pix_fmt', 'yuv420p', '-b:v', '4500k', '-maxrate', '6000k', '-bufsize', '9000k', '-g', '360', '-keyint_min', '360', '-sc_threshold', '0', '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments+temp_file', '-hls_segment_filename', path.join(dir, 'segment-%03d.ts'), path.join(dir, 'index.m3u8')];
  const start = Date.now();
  const log = fs.createWriteStream(path.join(dir, 'generate.log'));
  const child = spawn(ffmpeg, args, { windowsHide: true });
  child.stderr.pipe(log);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error(`${name}: ffmpeg exit ${code}`);
  const probe = spawn(ffmpeg.replace(/ffmpeg\.exe$/i, 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,avg_frame_rate:format=duration', '-of', 'json', path.join(dir, 'index.m3u8')], { windowsHide: true });
  let output = ''; probe.stdout.on('data', b => output += b);
  const probeCode = await new Promise(resolve => probe.once('close', resolve));
  return { name, command: [ffmpeg, ...args], generationWallSeconds: (Date.now()-start)/1000, exitCode: code, probeExitCode: probeCode, probe: JSON.parse(output), segments: fs.readdirSync(dir).filter(n => n.endsWith('.ts')).length };
}
(async () => {
  const streams = [];
  for (const [name, source] of [['testsrc2', 'testsrc2'], ['smptehdbars', 'smptehdbars']]) { const result = await run(name, source); streams.push(result); console.log(JSON.stringify(result)); }
  fs.mkdirSync(path.join(root, '.evidence'), { recursive: true });
  fs.writeFileSync(path.join(root, '.evidence', 'playback-generation.json'), JSON.stringify({ at: new Date().toISOString(), streams }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
