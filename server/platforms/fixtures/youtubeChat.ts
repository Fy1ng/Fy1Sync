export const youtubeChatFixture = {
  videoId: 'aaa111BBB22',
  nextVideoId: 'ccc333DDD44',
  channelId: 'UC' + 'a'.repeat(22),
  viewerChannelId: 'UC' + 'b'.repeat(22),
  liveChatId: 'chat-01=',
  otherChatId: 'chat-02=',
  startTime: '2026-11-19T12:00:00Z',
  nextStartTime: '2026-11-19T13:00:00Z',
  messageTime: '2026-11-19T12:00:01Z',
}

const fixture = youtubeChatFixture

export function youtubeFixtureMessage(id: string, type: string, snippet: Record<string, unknown> = {}) {
  return {
    id,
    snippet: { liveChatId: fixture.liveChatId, publishedAt: fixture.messageTime, type, ...snippet },
    authorDetails: {
      channelId: fixture.viewerChannelId,
      displayName: '测试观众',
      isChatOwner: false,
      isChatModerator: true,
      isChatSponsor: true,
      isVerified: false,
    },
  }
}

export const youtubeChatFixtureVideo = {
  items: [{
    id: fixture.videoId,
    snippet: { channelId: fixture.channelId },
    liveStreamingDetails: { activeLiveChatId: fixture.liveChatId, actualStartTime: fixture.startTime },
  }],
} as const

const hello = youtubeFixtureMessage('LCC.text-1', 'textMessageEvent', {
  displayMessage: '替代文本',
  textMessageDetails: { messageText: '直播好看 🎉 :channel_emoji:' },
})
const gift = (comboCount: number) => youtubeFixtureMessage('LCC.gift-1', 'giftEvent', {
  giftDetails: { comboCount, jewelsAmount: 25, giftName: '星星', altText: '一颗星星', language: 'zh-CN' },
})
const poll = (status: string, tally?: string) => youtubeFixtureMessage('LCC.poll-1', 'pollEvent', {
  pollDetails: { status, metadata: { questionText: '下一局?', options: [{ optionText: '继续', tally }, { optionText: '休息' }] } },
})
const tombstone = youtubeFixtureMessage('LCC.hidden', 'tombstone')

export const youtubeChatFixturePages = [{
  nextPageToken: 'cursor-1=',
  pollingIntervalMillis: 2800,
  activePollItem: poll('active'),
  items: [
    hello,
    { ...youtubeFixtureMessage('LCC.legacy', 'textMessageEvent', { displayMessage: ':legacy_emoji:' }), authorDetails: undefined },
    youtubeFixtureMessage('LCC.sc', 'superChatEvent', {
      superChatDetails: { amountMicros: '9007199254740993', currency: 'TWD', amountDisplayString: 'NT$75.00', tier: 2, userComment: '加油' },
    }),
    youtubeFixtureMessage('LCC.sticker', 'superStickerEvent', {
      superStickerDetails: {
        amountMicros: '2000000', amountDisplayString: '$2.00', currency: 'USD',
        superStickerMetadata: { stickerId: 'fixture-sticker-A', altText: '鼓掌', language: 'zh-CN' },
      },
    }),
    youtubeFixtureMessage('LCC.membership', 'newSponsorEvent', { newSponsorDetails: { memberLevelName: '银级', isUpgrade: false } }),
    youtubeFixtureMessage('LCC.milestone', 'memberMilestoneChatEvent', {
      memberMilestoneChatDetails: { memberLevelName: '银级', memberMonth: 6, userComment: '半年了' },
    }),
    youtubeFixtureMessage('LCC.gifted-1', 'membershipGiftingEvent', {
      membershipGiftingDetails: { giftMembershipsCount: 3, giftMembershipsLevelName: '银级' },
    }),
    youtubeFixtureMessage('LCC.received-1', 'giftMembershipReceivedEvent', {
      giftMembershipReceivedDetails: {
        associatedMembershipGiftingMessageId: 'LCC.gifted-1', gifterChannelId: fixture.viewerChannelId, memberLevelName: '银级',
      },
    }),
    gift(0),
    tombstone,
    youtubeFixtureMessage('LCC.foreign', 'textMessageEvent', { liveChatId: fixture.otherChatId, displayMessage: '另一场' }),
  ],
}, {
  nextPageToken: 'cursor-2=',
  pollingIntervalMillis: 3900,
  activePollItem: poll('active', '4'),
  items: [
    hello, gift(3), gift(1), gift(3),
    youtubeFixtureMessage('LCC.delete', 'messageDeletedEvent', { messageDeletedDetails: { deletedMessageId: hello.id } }),
    youtubeFixtureMessage('LCC.retract', 'messageRetractedEvent', { messageRetractedDetails: { retractedMessageId: 'LCC.late' } }),
    youtubeFixtureMessage('LCC.late', 'textMessageEvent', { displayMessage: '已撤回的晚到消息' }),
    youtubeFixtureMessage(tombstone.id, 'textMessageEvent', { displayMessage: '已删除的晚到消息' }),
  ],
}, {
  activePollItem: poll('active'),
  items: [poll('closed', '5'), hello, youtubeFixtureMessage('LCC.end', 'chatEndedEvent')],
}] as const
