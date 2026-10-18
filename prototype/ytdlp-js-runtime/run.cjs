const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createCookieContext } = require('../login/cookies.cjs');
let cookies;
const root = path.resolve(__dirname, '..');
const yt = process.env.YTDLP || '<home>\\AppData\\Local\\Python\\pythoncore-3.14-64\\Scripts\\yt-dlp.exe';
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electron)) throw new Error('Run npm run setup first');
const env = { ...process.env, ELECTRON_RUN_AS_NODE:'1', TEMP:path.join(root,'.runtime','tmp'), TMP:path.join(root,'.runtime','tmp') };
fs.mkdirSync(path.join(root,'.runtime','tmp'),{recursive:true});
fs.mkdirSync(path.join(root,'.media','runtime'),{recursive:true});
fs.mkdirSync(path.join(root,'.evidence'),{recursive:true});
function redact(s) { return cookies.diagnostics(s).replace(/^.*Proxy map:.*$/gm, '[debug] Proxy map: [redacted existing environment proxy]').replace(/https?:\/\/[^\s"'<>]+/g, '<remote URL>'); }
function run(file,args, label, timeout=90000) {
  return new Promise(resolve => {
    const start=Date.now(); const child=spawn(file,args,{env,windowsHide:true}); let out='',err='';
    child.stdout.on('data',b=>out+=b); child.stderr.on('data',b=>err+=b);
    const timer=setTimeout(()=>child.kill(),timeout);
    child.on('error',e=>{err+=String(e);});
    child.on('close',(code,signal)=>{clearTimeout(timer);fs.writeFileSync(path.join(root,'.media','runtime',label+'.stdout'),redact(out));fs.writeFileSync(path.join(root,'.media','runtime',label+'.stderr'),redact(err));resolve({command:[file,...args],exitCode:code,signal,wallSeconds:(Date.now()-start)/1000,stdout:out,stderr:err});});
  });
}
(async()=>{
  cookies=createCookieContext();
  const version=await run(yt,['--ignore-config','--version'],'version');
  const help=await run(yt,['--ignore-config','--help'],'help');
  const probe=await run(electron,['-p','JSON.stringify(process.versions)'],'electron-node-probe');
  const urls=process.argv.slice(2).length ? process.argv.slice(2) : ['https://www.youtube.com/watch?v=-PWMxjBgr0k'];
  const attempts=[];
  for(let i=0;i<urls.length;i++) {
    const args=['--ignore-config','--cache-dir',path.join(root,'.cache','yt-dlp-runtime'),'--no-js-runtimes','--js-runtimes',`node:${electron}`,'--no-remote-components','--no-playlist','--socket-timeout','15','--retries','0','--skip-download','--dump-single-json','--verbose',urls[i]];
    const r=await cookies.withYtdlpCookies(cookieArgs=>run(yt,[...cookieArgs,...args],'resolve-'+i,110000)); let data;
    try{data=JSON.parse(r.stdout);}catch{}
    attempts.push({command:r.command,env:{ELECTRON_RUN_AS_NODE:'1'},exitCode:r.exitCode,wallSeconds:r.wallSeconds,id:data?.id,isLive:data?.is_live,liveStatus:data?.live_status,formats:data?.formats?.length||0,runtimeDetected:/JS runtimes:.*node-/.test(r.stderr),challengeExecution:/\[jsc:node\].*(?:Solving|challenge)/i.test(r.stderr),stderr:redact(r.stderr)});
  }
  const evidence={at:new Date().toISOString(),cookiesEnabled:cookies.enabled,ytDlpVersion:version.stdout.trim(),electronProbe:{command:probe.command,env:{ELECTRON_RUN_AS_NODE:'1'},exitCode:probe.exitCode,versions:JSON.parse(probe.stdout)},helpExcerpt:help.stdout.slice(help.stdout.indexOf('--js-runtimes'),help.stdout.indexOf('--flat-playlist')),attempts};
  evidence.status=attempts.some(a=>a.exitCode===0 && a.isLive && a.formats>0 && a.runtimeDetected) ? 'PASS' : probe.exitCode===0 && attempts.some(a=>a.runtimeDetected) ? 'PARTIAL' : 'FAIL';
  fs.writeFileSync(path.join(root,'.evidence',`runtime-${evidence.ytDlpVersion}.json`),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
  process.exitCode=evidence.status==='PASS'?0:1;
})().catch(()=>{console.error('Runtime probe failed. Check P0_COOKIES (under prototype/.runtime/), executable paths and file permissions.');process.exitCode=1;});
