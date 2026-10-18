// P0c: play a local VP9/AAC fMP4 HLS (muxed from YouTube 1440p segments) in Electron with hls.js
// and report decode stats. Run: electron prototype/youtube-dash/play/main.cjs <dir with index.m3u8>
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const media = path.resolve(process.argv.at(-1));
const hls = path.resolve(__dirname, '../../../node_modules/hls.js/dist/hls.min.js');
protocol.registerSchemesAsPrivileged([{ scheme: 'probe', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.whenReady().then(async () => {
  protocol.handle('probe', request => {
    const name = new URL(request.url).pathname.slice(1);
    if (name === 'hls.js') return net.fetch(pathToFileURL(hls).toString());
    if (name === 'index.html') return new Response(`<style>body{margin:0}video{width:100vw;height:100vh}</style><video id=v muted></video><script src="/hls.js"></script><script>
      const v = document.getElementById('v'), h = new Hls();
      window.err = []; h.on(Hls.Events.ERROR, (_, d) => err.push(d.details + (d.fatal ? ' FATAL' : '')));
      h.loadSource('/m/index.m3u8'); h.attachMedia(v); v.play();
    </script>`, { headers: { 'content-type': 'text/html' } });
    if (name.startsWith('m/') && !name.includes('..')) return net.fetch(pathToFileURL(path.join(media, name.slice(2))).toString());
    return new Response('no', { status: 404 });
  });
  const win = new BrowserWindow({ show: true, width: 1280, height: 720, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await win.loadURL('probe://x/index.html');
  await new Promise(r => setTimeout(r, 6000));
  const s = await win.webContents.executeJavaScript(`(() => { const v = document.getElementById('v'), q = v.getVideoPlaybackQuality();
    return { canVp9: MediaSource.isTypeSupported('video/mp4; codecs="vp09.00.51.08"'), canAv1: MediaSource.isTypeSupported('video/mp4; codecs="av01.0.12M.08"'),
      w: v.videoWidth, h: v.videoHeight, t: v.currentTime, paused: v.paused, total: q.totalVideoFrames, dropped: q.droppedVideoFrames, err: window.err }; })()`);
  await new Promise(r => setTimeout(r, 15000));
  const s2 = await win.webContents.executeJavaScript(`(() => { const v = document.getElementById('v'), q = v.getVideoPlaybackQuality(); return { t: v.currentTime, total: q.totalVideoFrames, dropped: q.droppedVideoFrames }; })()`);
  const dbg = win.webContents.debugger; dbg.attach('1.3'); const props = []; dbg.on('message', (_, m, p) => { if (m === 'Media.playerPropertiesChanged') for (const x of p.properties) if (/decoder|hardware/i.test(x.name)) props.push(x.name + '=' + x.value); }); await dbg.sendCommand('Media.enable'); await new Promise(r => setTimeout(r, 3000)); s.decoder = [...new Set(props)];
  const gpu = await app.getGPUFeatureStatus();
  console.log(JSON.stringify({ ...s, after5s: s2, fps: (s2.total - s.total) / 15, droppedPerSec: (s2.dropped - s.dropped) / 15, videoDecode: gpu.video_decode }));
  app.quit();
});
