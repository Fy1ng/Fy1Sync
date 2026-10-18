// Download only to the ignored prototype runtime directory, with official digest verification.
const fs=require('node:fs');const path=require('node:path');const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');
(async()=>{
  const releaseResponse=await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest');if(!releaseResponse.ok)throw new Error('Release metadata HTTP '+releaseResponse.status);
  const release=await releaseResponse.json();
  const exe=release.assets.find(a=>a.name==='yt-dlp.exe'),sums=release.assets.find(a=>a.name==='SHA2-256SUMS');
  if(!exe||!sums)throw new Error('Missing official assets');
  const [exeResponse,sumResponse]=await Promise.all([fetch(exe.browser_download_url),fetch(sums.browser_download_url)]);
  if(!exeResponse.ok||!sumResponse.ok)throw new Error('Asset HTTP '+exeResponse.status+'/'+sumResponse.status);
  const bytes=Buffer.from(await exeResponse.arrayBuffer()),sumText=await sumResponse.text();
  const expected=sumText.split('\n').find(l=>/\s\*?yt-dlp\.exe\s*$/.test(l))?.split(/\s+/)[0];
  const actual=createHash('sha256').update(bytes).digest('hex');if(actual!==expected)throw new Error('SHA256 mismatch');
  const dir=path.join(root,'.runtime','yt-dlp');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'yt-dlp.exe'),bytes);
  fs.mkdirSync(path.join(root,'.evidence'),{recursive:true});
  const result={at:new Date().toISOString(),tag:release.tag_name,publishedAt:release.published_at,url:exe.browser_download_url,bytes:bytes.length,sha256:actual,sha256Verified:true,path:path.join(dir,'yt-dlp.exe')};fs.writeFileSync(path.join(root,'.evidence','runtime-download.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  const docs=await fetch('https://github.com/yt-dlp/yt-dlp/wiki/EJS');const text=await docs.text();fs.writeFileSync(path.join(root,'.runtime','yt-dlp','EJS.html'),text);console.log('EJS docs HTTP '+docs.status);
})().catch(e=>{console.error(e);process.exitCode=1;});
