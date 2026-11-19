export const twitchFixtureChannel = '10001'
export const twitchFixtureOrigin = '10002'
export const twitchFixtureViewer = '10003'
export const twitchFixtureSender = '10004'

export const twitchFixtureMessage = {
  broadcaster_user_id: twitchFixtureChannel,
  broadcaster_user_login: 'fixture_room',
  chatter_user_id: twitchFixtureSender,
  chatter_user_login: 'fixture_sender',
  chatter_user_name: 'Fixture Sender',
  message_id: 'delivery-42',
  source_broadcaster_user_id: twitchFixtureOrigin,
  source_broadcaster_user_login: 'fixture_origin',
  source_broadcaster_user_name: 'Fixture Origin',
  source_message_id: 'origin-42',
  badges: [{ set_id: 'moderator', id: '1', info: '' }],
  source_badges: [{ set_id: 'subscriber', id: '12', info: '18' }],
  color: '#123ABC',
  message_type: 'text',
  message: {
    text: 'Hi Kappa Cheer10',
    fragments: [
      { type: 'text', text: 'Hi ' },
      { type: 'emote', text: 'Kappa', emote: { id: '25', emote_set_id: '0', owner_id: '0', format: ['static'] } },
      { type: 'text', text: ' ' },
      { type: 'cheermote', text: 'Cheer10', cheermote: { prefix: 'Cheer', bits: 10, tier: 1 } },
    ],
  },
  cheer: { bits: 10 },
  reply: { parent_message_id: 'parent-1', parent_message_body: 'Hello!', thread_message_id: 'thread-1' },
}

export function twitchFixtureFrame(messageType: string, payload: object, id = messageType): string {
  return JSON.stringify({ metadata: { message_type: messageType, message_id: id }, payload })
}

export function twitchFixtureNotify(
  id: string,
  type: string,
  event: object,
  condition: object = type.startsWith('channel.chat.')
    ? { broadcaster_user_id: twitchFixtureChannel, user_id: twitchFixtureViewer }
    : { broadcaster_user_id: twitchFixtureChannel },
  version = '1',
): string {
  return twitchFixtureFrame('notification', { subscription: { type, version, condition }, event }, id)
}
