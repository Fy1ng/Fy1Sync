import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { browserIdentityVerifier } from './browserImportIdentity'
import { BrowserLoginImport } from './browserLoginImport'
import { cookieDomainAllowed } from './cookies'
import { parseManualCookies } from './manualCookies'
import { LoginManager } from './login'

const token = 'synthetic0123456789abcdefghijklmn'
const credentials = () => parseManualCookies(`auth-token=${token}`, 'twitch')

describe('Twitch manual Cookie login on the shared upstream account flow', () => {
  it('previews and imports a manually supplied session through GQL currentUser', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fy1-twitch-'))
    const fetch = vi.fn(async () => Response.json({ data: { currentUser: { id: '42', login: 'fixture_user', displayName: '测试账号' } } }))
    const verify = browserIdentityVerifier(fetch, () => undefined)
    const manager = new LoginManager(root, { identify: verify })
    const service = new BrowserLoginImport({ supported: false, verify,
      read: async () => ({ cookies: [], skipped: 0 }),
      write: async (platform, cookies, identity, _target, signal) => {
        await manager.importCookies(platform, cookies, identity, signal)
        return {}
      },
    })
    try {
      const preview = await service.scanManual({ requestId: 'a'.repeat(32), platform: 'twitch', text: `auth-token=${token}` })
      expect(preview.accounts[0]).toMatchObject({ platform: 'twitch', username: '测试账号', state: 'ready' })
      expect(JSON.stringify(preview)).not.toContain(token)
      expect(fetch).toHaveBeenCalledWith('twitch', 'https://gql.twitch.tv/gql', expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `OAuth ${token}` }),
        body: expect.stringContaining('currentUser'),
      }))
      const result = await service.apply({ previewId: preview.id, accountIds: [preview.accounts[0]!.id] })
      expect(result.outcomes[0]?.imported).toBe(true)
      expect((await manager.loginStatus()).twitch).toMatchObject({ loggedIn: true, nickname: '测试账号' })
      expect(await manager.twitchAuthorization('https://gql.twitch.tv/gql')).toBe(`OAuth ${token}`)
      await expect(manager.twitchAuthorization('https://other.invalid/')).rejects.toThrow()
      await manager.logout('twitch')
      expect(await manager.twitchAuthorization('https://gql.twitch.tv/gql')).toBe('')
    } finally { service.dispose(); await manager.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
  })
  it('preserves Twitch domain restrictions when parsing manual input', () => {
    expect(credentials()[0]?.domain).toBe('.twitch.tv')
    expect(cookieDomainAllowed('.twitch.tv', 'twitch')).toBe(true)
    expect(cookieDomainAllowed('.twitch.com', 'twitch')).toBe(false)
  })
})
