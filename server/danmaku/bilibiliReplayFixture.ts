export const bilibiliReplayRoom = '123456'
export const bilibiliReplayAt = 1_790_000_000_000
const image = 'https://i0.hdslb.com/bfs/emote/fy1sync-fixture.png'

export const bilibiliReplay = {
  text: { cmd: 'DANMU_MSG:4:0:2:2:2:0', info: [[0, 1, 25, 0x12ab34], '测试文字', [42, '测试观众']] },
  inline: { cmd: 'DANMU_MSG', info: [
    [...Array(15).fill(null), {
      extra: JSON.stringify({ id_str: 'inline-fixture', emots: { '[笑]': { url: image } } }),
      user: { glory: { level: 18 }, base: { site_level: 6 }, medal: { name: '测试勋章', level: 13, target_id: 1001, wearing_status: false } },
    }],
    '你好[笑]', [42, '测试观众', 1], [], [], [], [], 3,
  ] },
  image: { cmd: 'DANMU_MSG', info: [[...Array(13).fill(null), { url: image }], '[整条表情]', [42, '测试观众']] },
  superChat: { cmd: 'SUPER_CHAT_MESSAGE', data: {
    id: 99, room_id: 123456, uid: 42, price: 30, time: 90, message: '测试醒目留言', start_time: 1_790_000_000, end_time: 1_790_000_090,
    background_bottom_color: '#1565c0', message_font_color: '#ffffff', user_info: { uname: '测试观众' },
  } },
  deleteSuperChat: { cmd: 'SUPER_CHAT_MESSAGE_DELETE', data: { room_id: 123456, ids: [99] } },
  gift: { cmd: 'SEND_GIFT', data: {
    room_id: 123456, uid: 42, giftId: 1001, giftName: '测试礼物', num: 2, paid: true, bag_gift: true,
    tid: 'gift-fixture', batch_combo_send: { batch_combo_id: 'combo-fixture', batch_combo_num: 12 },
  } },
  watched: { cmd: 'WATCHED_CHANGE', data: { room_id: 123456, num: 1024 } },
} as const
