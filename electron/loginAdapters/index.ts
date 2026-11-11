import type { EmbeddedLoginPlatform } from '../embeddedLoginContracts'
import type { LoginPageAdapter } from '../loginCardContracts'
import { douyinLoginAdapter } from './douyin'
import { bilibiliLoginAdapter } from './bilibili'
import { douyuLoginAdapter } from './douyu'
import { huyaLoginAdapter } from './huya'

export const LOGIN_ADAPTERS: Record<EmbeddedLoginPlatform, LoginPageAdapter> = {
  douyin: douyinLoginAdapter, bilibili: bilibiliLoginAdapter, douyu: douyuLoginAdapter, huya: huyaLoginAdapter,
}
