/** Synthetic protocol shapes observed on public pages. No captured user or session data. */
import room from './douyin-room.json'

export const syntheticDouyinRoom = () => structuredClone(room)

export function syntheticDouyinPage(value: unknown = syntheticDouyinRoom(), webRoom = '100', h264?: unknown): string {
  const state = { roomStore: { roomInfo: { web_rid: webRoom, roomId: '9000000000000000001', room: value } },
    ...(h264 ? { cameraStore: { cameraInfo: { h264Stream: h264 } } } : {}) }
  return `<html><script>self.__pace_f.push(${JSON.stringify([1, '0:' + JSON.stringify(['$', 'div', null, { state }]) + '\n'])})</script></html>`
}

export function syntheticDouyinReflow(webRoom?: string): string {
  const value = { room: { idStr: '9000000000000000001', status: 4,
    owner: { ...(webRoom ? { webRid: webRoom } : {}) }, streamUrl: {
      flvPullUrl: { FULL_HD1: 'https://media.douyincdn.com/expired.flv' },
    } } }
  return `<script>self.__rsc_f.push(${JSON.stringify([1, '0:' + JSON.stringify(['$', 'div', null, value]) + '\n'])})</script>`
}
