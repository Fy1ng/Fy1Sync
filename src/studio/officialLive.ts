/**
 * Finding the CS2 tournament that is on right now, without the viewer pasting a link.
 *
 * The organisers that run the big CS2 events each broadcast from one YouTube channel, and a
 * channel's `/live` address resolves to whatever it is airing. So "find the live one" is: try
 * the channels in turn and keep the first that resolves. The resolver already understands
 * `@handle/live`, and a channel that is not live fails fast with `not-live`.
 *
 * Handles checked on 2026-10-27 against youtube.com; the order is a guess at which is most
 * often live during a big event. Each is tried for at most one resolve.
 */

export interface OfficialChannel { handle: string; name: string }

export const CS2_CHANNELS: readonly OfficialChannel[] = [
  { handle: 'BLASTPremier', name: 'BLAST' },
  { handle: 'ESLCS', name: 'ESL Counter-Strike' },
  { handle: 'PGL', name: 'PGL' },
  { handle: 'Starladder_CS', name: 'StarLadder CS2' },
  { handle: 'BLASTtv', name: 'BLAST.tv' },
  { handle: 'FACEITTV', name: 'FACEIT TV' },
]

export const channelLiveUrl = (channel: OfficialChannel): string => `https://www.youtube.com/@${channel.handle}/live`

/**
 * Try each channel until one plays. `load` returns true when the source loaded; a false is a
 * channel that is not live (or failed), and the next is tried. `onTry` reports progress.
 */
export async function findLiveOfficial(
  load: (url: string) => Promise<boolean>,
  onTry: (channel: OfficialChannel, index: number) => void = () => {},
  channels: readonly OfficialChannel[] = CS2_CHANNELS,
  cancelled: () => boolean = () => false,
): Promise<OfficialChannel | null> {
  for (const [index, channel] of channels.entries()) {
    if (cancelled()) return null
    onTry(channel, index)
    if (await load(channelLiveUrl(channel))) return channel
  }
  return null
}
