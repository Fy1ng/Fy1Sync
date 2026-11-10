import { describe, expect, it } from 'vitest'
import { loginMediaRequest } from './loginMediaGuard'

describe('login media prohibition', () => {
  it.each([
    ['https://www.huya.com/sample', 'media'], ['https://hs.flv.huya.com/src/playlist.flv', 'xhr'],
    ['https://live.cdn.huya.com/stream.m3u8?token=fixture', 'xhr'], ['wss://ws.huya.com/stream.flv', 'webSocket'],
    ['https://cdn.msstatic.com/sample.mp4', 'other'], ['https://static.geetest.com/example.wav', 'media'],
    ['https://x.huya.com/huyalive/stream', 'xhr'],
  ])('blocks media request %s even outside Chromium media classification', (url, type) => expect(loginMediaRequest(url, type)).toBe(true))
  it.each(['https://aq.huya.com/p/udb_login.html', 'https://captcha.gtimg.com/static/tcaptcha-frame.js', 'https://api.geetest.com/get.php', 'https://passport.douyu.com/japi/scan/auth'])('preserves login and visual verification %s', url => {
    expect(loginMediaRequest(url, 'xhr')).toBe(false)
  })
})
