const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, ms, label) { const start = performance.now(); while (!test()) { if (performance.now() - start > ms) throw new Error('Timeout: ' + label); await sleep(50); } }
const ranges = r => Array.from({ length:r.length }, (_, i) => [r.start(i), r.end(i)]);
const quality = video => { const q = video.getVideoPlaybackQuality(); return { total:q.totalVideoFrames, dropped:q.droppedVideoFrames, corrupted:q.corruptedVideoFrames }; };
function canvasCheck(video) {
  const canvas = document.createElement('canvas'); canvas.width=160; canvas.height=90;
  const ctx = canvas.getContext('2d', { willReadFrequently:true }); ctx.drawImage(video, 0, 0, 160, 90);
  const pixels = ctx.getImageData(0, 0, 160, 90).data;
  let checksum = 0; for (const value of pixels) checksum = (checksum + value) >>> 0;
  return { success:true, bytes:pixels.length, checksum, dimensions:[video.videoWidth,video.videoHeight] };
}
window.p0Result = (async () => {
  const result = { status:'FAIL', rendererBoundary:{ process:typeof process, require:typeof require, isolated:typeof process === 'undefined' && typeof require === 'undefined' }, streams:[] };
  const active=[];
  try {
    const config = await (await fetch('stream://app/config.json')).json();
    if (!Hls.isSupported()) throw new Error('MSE/HLS unsupported');
    for (const source of config.sources) {
      const article = document.createElement('article'), title=document.createElement('p'), video=document.createElement('video');
      title.textContent=source; video.muted=true; video.autoplay=true; video.controls=true; video.crossOrigin='anonymous'; article.append(title,video); document.getElementById('streams').append(article);
      const hls = new Hls({ enableWorker:true, maxBufferLength:30, maxMaxBufferLength:180, backBufferLength:180, liveSyncDurationCount:3, liveMaxLatencyDurationCount:Infinity, maxLiveSyncPlaybackRate:1, lowLatencyMode:false });
      const data={ source, errors:[], callbacks:0, regressions:0, firstMediaTime:null, lastMediaTime:null, maxFrameGap:0, waitingEvents:0 };
      let measuring=false;
      video.addEventListener('waiting', () => { if (measuring) data.waitingEvents++; });
      hls.on(Hls.Events.ERROR, (_event,error) => { data.errors.push({ type:error.type,details:error.details,fatal:error.fatal }); });
      const callback=(_now,meta) => { if (measuring) { data.callbacks++; if (data.firstMediaTime===null) data.firstMediaTime=meta.mediaTime; if(data.lastMediaTime!==null) { if(meta.mediaTime<=data.lastMediaTime)data.regressions++; data.maxFrameGap=Math.max(data.maxFrameGap,meta.mediaTime-data.lastMediaTime); } data.lastMediaTime=meta.mediaTime; } video.requestVideoFrameCallback(callback); };
      video.requestVideoFrameCallback(callback); hls.loadSource('stream://media/'+source); hls.attachMedia(video);
      active.push({ video,hls,data,measure:value => measuring=value }); result.streams.push(data);
    }
    await Promise.all(active.map(async ({video}) => { await until(() => video.readyState>=2, 45000, 'first playable frame'); await video.play(); }));
    if (config.mode==='vod') { for (const {video} of active) video.currentTime=45; await until(() => active.every(({video}) => !video.seeking && video.currentTime>=44.5), 20000, 'start at 45s'); }
    await sleep(1000);
    for (const item of active) { item.data.qualityBefore=quality(item.video); item.data.currentTimeBefore=item.video.currentTime; item.data.canvas=canvasCheck(item.video); item.measure(true); }
    const measureStart=performance.now(); await sleep(config.measureSeconds*1000);
    result.measureWallSeconds=(performance.now()-measureStart)/1000;
    for(const item of active) { item.measure(false); const {video,data}=item; data.qualityAfter=quality(video); data.frameDelta=data.qualityAfter.total-data.qualityBefore.total; data.droppedDelta=data.qualityAfter.dropped-data.qualityBefore.dropped; data.droppedPercent=data.frameDelta ? 100*data.droppedDelta/data.frameDelta : null; data.currentTimeAfter=video.currentTime; data.seekableBefore=ranges(video.seekable); }
    for(const {video,data} of active) {
      const before=video.currentTime, target=before-config.seekSeconds;
      if(!ranges(video.seekable).some(([start,end]) => target>=start && target<end)) throw new Error(`Seek target ${target} outside retained range for ${data.source}`);
      video.pause(); const start=performance.now(); video.currentTime=target;
      await until(() => !video.seeking && Math.abs(video.currentTime-target)<0.4 && video.readyState>=2, 20000,'backward seek');
      data.seek={ before,target,landed:video.currentTime,errorSeconds:Math.abs(video.currentTime-target),wallMs:performance.now()-start,requestedBackSeconds:config.seekSeconds };
      await video.play(); const landed=video.currentTime; await sleep(8000); data.seek.after8Seconds=video.currentTime; data.seek.progressSeconds=video.currentTime-landed; data.seek.canvasAfter=canvasCheck(video); data.seek.retained=video.currentTime<before- config.seekSeconds + 11; data.seek.resumed=data.seek.progressSeconds>6.5 && data.seek.progressSeconds<10;
    }
    result.status=result.rendererBoundary.isolated && result.streams.every(s => s.callbacks>100 && s.regressions===0 && s.lastMediaTime-s.firstMediaTime>28 && s.canvas.success && s.seek.errorSeconds<0.4 && s.seek.resumed && s.seek.retained && !s.errors.some(e=>e.fatal)) ? 'PASS' : 'FAIL';
    document.getElementById('state').textContent=result.status;
  } catch(error) { result.problem=String(error.stack||error); document.getElementById('state').textContent='FAIL: '+error.message; }
  document.getElementById('output').textContent=JSON.stringify(result,null,2);
  for(const {hls} of active) hls.destroy();
  return result;
})();
