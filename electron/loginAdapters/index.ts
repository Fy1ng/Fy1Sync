import type { EmbeddedLoginPlatform } from '../embeddedLoginContracts'
import type { LoginPageAdapter } from '../loginCardContracts'
import { douyinLoginAdapter } from './douyin'

export const LOGIN_ADAPTERS: Record<EmbeddedLoginPlatform, LoginPageAdapter> = {
  douyin: douyinLoginAdapter,
}
