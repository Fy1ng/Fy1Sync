const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const config = { mode: argv[0] === 'live' ? 'live' : 'vod', sources: argv[0] === 'live' ? argv.slice(1) : ['testsrc2/index.m3u8', 'smptehdbars/index.m3u8'], measureSeconds: 30, seekSeconds: argv[0] === 'live' ? 120 : 30 };
if (!config.sources.length || config.sources.some(s => s.includes('..') || !/^[a-zA-Z0-9_\-/]+\.m3u8$/.test(s))) throw new Error('Only local .media relative playlists are admitted');
for (const name of ['tmp', 'appData', 'userData', 'crashDumps', 'cache']) fs.mkdirSync(path.join(root, '.runtime', name), { recursive: true });
const env = { ...process.env, P0_CONFIG: JSON.stringify(config), TEMP: path.join(root, '.runtime', 'tmp'), TMP: path.join(root, '.runtime', 'tmp') };
delete env.ELECTRON_RUN_AS_NODE;
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electron)) throw new Error('Run npm run setup first');
const args = [path.join(__dirname, 'main.cjs'), '--disk-cache-dir=' + path.join(root, '.runtime', 'cache')];
console.log(JSON.stringify({ command: [electron, ...args], config }));
const started=Date.now();
const child = spawn(electron, args, { env, windowsHide: true, stdio:['ignore','pipe','pipe'] });
let stdout='',stderr='';
child.stdout.on('data', data=>{stdout+=data;process.stdout.write(data);});
child.stderr.on('data', data=>{stderr+=data;process.stderr.write(data);});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', code => {
  fs.mkdirSync(path.join(root,'.evidence'),{recursive:true});
  const file=path.join(root,'.evidence','playback-attempts.json');
  let attempts=[];try{attempts=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  attempts.push({at:new Date().toISOString(),command:[electron,...args],config,softwareFallback:env.P0_SOFTWARE==='1',exitCode:code,wallSeconds:(Date.now()-started)/1000,stdout,stderr});
  fs.writeFileSync(file,JSON.stringify(attempts,null,2));process.exitCode=code??1;
});
