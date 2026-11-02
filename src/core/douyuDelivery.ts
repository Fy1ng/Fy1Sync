/** The strict room tracker owns matching; this only interprets its independent evidence. */
export interface RoomDeliveryEvidence {
  gateway: 'pending' | 'accepted' | 'rejected' | 'unknown'
  roomEcho: 'pending' | 'observed' | 'not-observed'
}

export const ROOM_OBSERVED_SEND_MESSAGE = '已发送, 已在房间中显示.'

/** An unknown receipt is sufficient only when the strict tracker observed this exact send. */
export function roomEchoConfirmsSend(evidence: RoomDeliveryEvidence | null | undefined): boolean {
  return evidence?.gateway === 'unknown' && evidence.roomEcho === 'observed'
}
