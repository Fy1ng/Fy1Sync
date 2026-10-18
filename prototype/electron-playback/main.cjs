const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const mediaRoot = path.join(root, '.media');
const config = JSON.parse(process.env.P0_CONFIG);
if (process.env.P0_SOFTWARE === '1') app.disableHardwareAcceleration();
for (const name of ['appData', 'userData', 'crashDumps']) app.setPath(name, path.join(root, '.runtime', name));
app.setAppLogsPath(path.join(root, '.runtime', 'logs'));
protocol.registerSchemesAsPrivileged([{ scheme: 'stream', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const prefs = { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false };
let window;
const launchFailures = [];
function saveEvidence(result) {
  fs.mkdirSync(path.join(root, '.evidence'), { recursive: true });
  const evidence = { at:new Date().toISOString(), versions:process.versions, config, preferences:prefs, softwareFallback:process.env.P0_SOFTWARE==='1', launchFailures, ...result };
  fs.writeFileSync(path.join(root, '.evidence', config.mode==='live' ? 'playback-live.json' : 'playback-vod.json'), JSON.stringify(evidence,null,2));
  return evidence;
}
function serveFile(file, request, media = false) {
  const data = fs.readFileSync(file);
  const ext = path.extname(file);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4' };
  const headers = { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  if (media) headers['Access-Control-Allow-Origin'] = 'stream://app';
  if (ext === '.html') headers['Content-Security-Policy'] = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' stream://media; media-src blob: stream://media; worker-src blob:; img-src 'self' data:";
  const range = request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416 });
    const start = Number(match[1]), end = Math.min(match[2] ? Number(match[2]) : data.length - 1, data.length - 1);
    if (start > end || start >= data.length) return new Response(null, { status: 416 });
    return new Response(request.method === 'HEAD' ? null : data.subarray(start, end+1), { status: 206, headers: { ...headers, 'Content-Length': String(end-start+1), 'Content-Range': `bytes ${start}-${end}/${data.length}` } });
  }
  return new Response(request.method === 'HEAD' ? null : data, { headers: { ...headers, 'Content-Length': String(data.length) } });
}
function handler(request) {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const url = new URL(request.url);
    if (url.hostname === 'app') {
      if (url.pathname === '/config.json') return Response.json(config);
      const files = { '/index.html': path.join(__dirname, 'index.html'), '/renderer.js': path.join(__dirname, 'renderer.js'), '/hls.js': path.join(root, 'node_modules', 'hls.js', 'dist', 'hls.js') };
      return files[url.pathname] ? serveFile(files[url.pathname], request) : new Response(null, { status: 404 });
    }
    if (url.hostname !== 'media') return new Response(null, { status: 403 });
    const file = path.resolve(mediaRoot, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(mediaRoot + path.sep) || !fs.realpathSync(file).startsWith(fs.realpathSync(mediaRoot) + path.sep)) return new Response(null, { status: 403 });
    return serveFile(file, request, true);
  } catch (error) { console.error('Protocol error: ' + error.message); return new Response(null, { status: 404 }); }
}
app.whenReady().then(async () => {
  protocol.handle('stream', handler);
  window = new BrowserWindow({ width: 1400, height: 850, show: true, webPreferences: prefs });
  window.webContents.on('render-process-gone', (_event, details) => { launchFailures.push(details); console.error('Renderer exited: ' + JSON.stringify(details)); });
  window.webContents.on('did-fail-load', (_event, code, description) => console.error('Load failed: ' + code + ' ' + description));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== 'stream://app/index.html') event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  const timer = setTimeout(() => { console.error('P0 app deadline exceeded'); app.exit(2); }, 160000);
  try {
    await window.loadURL('stream://app/index.html');
    const result = await window.webContents.executeJavaScript('window.p0Result');
    const evidence = saveEvidence({ gpu:app.getGPUFeatureStatus(), ...result });
    console.log('P0_RESULT ' + JSON.stringify(evidence));
    clearTimeout(timer);
    app.exit(result.status === 'PASS' ? 0 : 1);
  } catch (error) { clearTimeout(timer); saveEvidence({ status:'FAIL', startupError:{message:error.message,code:error.code,errno:error.errno}, measurements:null, measurementProblem:'Renderer did not start; frames, canvas, dropped frames and seek are not observed.' }); console.error(error); app.exit(1); }
}).catch(e => { console.error(e); app.exit(1); });
app.on('window-all-closed', () => app.quit());
