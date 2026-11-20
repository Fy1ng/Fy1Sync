import { describe, expect, it, vi } from 'vitest'
import { TwitchHelix } from './twitchHelix'

const oauth = { clientId: 'fixture-client', accessToken: 'fixture-token' }

describe('Twitch official Helix readback adapter', () => {
  it('binds a login to a channel ID and explicitly matches the current live stream by that ID', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [
        { login: 'different', id: '12' }, { login: 'fixture_room', id: '34', display_name: 'Fixture Room' },
      ] }))
      .mockResolvedValueOnce(Response.json({ data: [
        { id: '55', user_id: '12', type: 'live', started_at: '2026-11-19T01:00:00Z' },
        { id: '56', user_id: '34', type: 'live', started_at: '2026-11-19T02:00:00Z' },
      ] }))
      .mockResolvedValueOnce(Response.json({ data: [] }))
    const helix = new TwitchHelix(fetch, oauth)
    const signal = new AbortController().signal
    const channel = await helix.channel('https://www.twitch.tv/FIXTURE_ROOM', signal)
    expect(channel).toEqual({ id: '34', login: 'fixture_room', displayName: 'Fixture Room' })
    expect(await helix.liveStream(channel!.id, signal)).toEqual({ id: '56', startedAt: Date.parse('2026-11-19T02:00:00Z') })
    expect(await helix.liveStream('34', signal)).toBeNull()
    expect(await helix.liveStream('fixture_room', signal)).toBeNull()
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.twitch.tv/helix/users?login=fixture_room',
      'https://api.twitch.tv/helix/streams?user_id=34',
      'https://api.twitch.tv/helix/streams?user_id=34',
    ])
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', headers: { 'Client-Id': oauth.clientId, Authorization: `Bearer ${oauth.accessToken}` } })
  })

  it('rejects mismatched OAuth app identity and hides upstream credential-like details', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ client_id: 'another-client', user_id: '34', scopes: ['user:read:chat'] }))
      .mockResolvedValueOnce(Response.json({ message: oauth.accessToken }, { status: 403 }))
    const helix = new TwitchHelix(fetch, oauth)
    const signal = new AbortController().signal
    await expect(helix.validateUser(signal)).rejects.toMatchObject({ status: 401 })
    await expect(helix.channel('fixture_room', signal)).rejects.toMatchObject({ status: 403, message: 'Twitch 授权范围或频道权限不足' })
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: `OAuth ${oauth.accessToken}` } })
  })

  it('rejects wrong-channel stream readback and never calls fetch for a cancelled query', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ id: '88', user_id: '99', type: 'live' }] }))
    const helix = new TwitchHelix(fetch, oauth)
    const controller = new AbortController()
    await expect(helix.liveStream('34', controller.signal)).rejects.toMatchObject({ status: null })
    controller.abort()
    await expect(helix.channel('fixture_room', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('reads channel and global badge versions, omitting unrecognized asset URLs', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ set_id: 'subscriber', versions: [
      { id: '6', title: '6 months', image_url_2x: 'https://static-cdn.jtvnw.net/badges/v1/fixture/2' },
      { id: '7', title: 'Other', image_url_2x: 'https://fixture.invalid/badges/v1/fixture/2' },
    ] }] }))
    const helix = new TwitchHelix(fetch, oauth)
    const signal = new AbortController().signal
    const badge = { id: '6', setId: 'subscriber', title: '6 months', imageUrl: 'https://static-cdn.jtvnw.net/badges/v1/fixture/2' }
    expect(await helix.badges('34', signal)).toEqual([badge])
    expect(await helix.badges(null, signal)).toEqual([badge])
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.twitch.tv/helix/chat/badges?broadcaster_id=34', expect.anything())
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.twitch.tv/helix/chat/badges/global', expect.anything())
  })

  it('reads existing shared chat and distinguishes a successful empty result from a failed request', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ session_id: 'fixture', host_broadcaster_id: '12',
        participants: [{ broadcaster_id: '34' }], created_at: '2026-11-19T02:00:00Z' }] }))
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
    const helix = new TwitchHelix(fetch, oauth)
    const signal = new AbortController().signal
    expect(await helix.sharedChat('34', signal)).toEqual({
      sessionId: 'fixture', hostId: '12', participantIds: ['34'], createdAt: Date.parse('2026-11-19T02:00:00Z'),
    })
    expect(await helix.sharedChat('34', signal)).toBeNull()
    await expect(helix.sharedChat('34', signal)).rejects.toMatchObject({ status: 401 })
    expect(fetch).toHaveBeenCalledWith('https://api.twitch.tv/helix/shared_chat/session?broadcaster_id=34', expect.anything())
  })
})
