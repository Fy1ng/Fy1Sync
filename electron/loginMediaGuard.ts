/** Installed before page scripts in every official login frame. It cannot access app APIs. */
export const LOGIN_MEDIA_GUARD = String.raw`(() => {
  const key = '__fy1syncLoginMediaDisabled';
  if (globalThis[key]) return;
  Object.defineProperty(globalThis, key, { value: true });
  const stop = media => {
    try { media.muted = true; media.autoplay = false; media.pause(); media.removeAttribute('autoplay'); } catch {}
  };
  const blockPlay = function() { stop(this); return Promise.reject(new DOMException('登录时禁止媒体播放', 'NotAllowedError')); };
  try { Object.defineProperty(HTMLMediaElement.prototype, 'play', { value: blockPlay, writable: false, configurable: false }); } catch {}
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Context = globalThis[name];
    if (!Context) continue;
    try {
      Object.defineProperty(Context.prototype, 'resume', { value: function() { return Promise.reject(new DOMException('登录时禁止媒体播放', 'NotAllowedError')); }, configurable: false });
    } catch {}
  }
  for (const name of ['play', 'playing', 'loadedmetadata', 'canplay']) document.addEventListener(name, event => {
    if (event.target instanceof HTMLMediaElement) { event.preventDefault(); stop(event.target); }
  }, true);
  const scan = () => { for (const media of document.querySelectorAll('video,audio')) stop(media); };
  new MutationObserver(scan).observe(document, { childList: true, subtree: true });
  scan();
})();`

/** Includes MSE/fetch and WebSocket media requests that are not tagged as resourceType media. */
export function loginMediaRequest(raw: string, resourceType: string): boolean {
  if (resourceType === 'media') return true
  try {
    const url = new URL(raw)
    if (/\.(?:m3u8|mpd|flv|f4v|mp4|m4s|m4v|m4a|mp3|aac|ogg|opus|wav|webm|ts)(?:$|\/)/i.test(url.pathname)) return true
    return /(?:^|\.)(?:flv|hls|vod|live-play|pull|pull-hls|pull-flv)\./i.test(url.hostname)
      || /(?:^|\.)(?:bilivideo\.com|huya\.com)$/.test(url.hostname) && /\/(?:huyalive|live-flv|live-hls|live-bvc|live-bvc[0-9]+)\//i.test(url.pathname)
  } catch { return false }
}
