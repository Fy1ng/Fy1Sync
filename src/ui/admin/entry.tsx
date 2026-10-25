/**
 * The scene editor's chunk, with its stylesheet. The player has its own (src/studio), so
 * this one only loads when /admin is opened — and 返回播放器 is a full navigation, so it
 * never lingers under the player afterwards.
 */

import '../styles.css'

export { default } from './AdminPage'
