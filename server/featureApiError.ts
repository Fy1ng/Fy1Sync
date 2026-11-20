export const ERROR_TEXT = {
  'invalid-arguments': '操作信息无效', 'not-available': '此操作暂不可用，请稍后重试', 'not-found': '未找到该功能或记录',
  'account-changed': '当前账号已变更，请重新确认', 'account-busy': '账号正在登录或退出，请稍后重试',
  'login-required': '请先登录当前斗鱼账号', 'room-changed': '当前操作房间已变化，请重新选择',
  forbidden: '当前窗口无权执行该操作', cancelled: '操作已取消', 'service-closed': '此操作暂不可用，请重新启动 Fy1Sync',
  'favorite-limit': '本地弹幕收藏已达到容量上限，请先删除部分收藏',
  'room-limit': '最多收藏 100 个直播间，请先取消部分收藏',
  'storage-failed': '本地设置读取或保存失败，请检查配置后重试',
  'account-not-found': '斗鱼账号不存在', 'account-limit': '斗鱼账号数量已达到上限',
  'no-active-account': '请先选择当前斗鱼账号', disposed: '此操作暂不可用，请重新启动 Fy1Sync',
  'task-not-found': '未找到该任务', 'task-limit': '任务数量已达到上限', 'task-exists': '该账号在此房间已有相同任务',
  empty: '请输入弹幕内容', 'too-long': '算上前后缀后太长，请缩短弹幕',
  'invalid-text': '弹幕含不支持的字符，请改为单行文字', 'invalid-options': '请检查弹幕前后缀设置',
  'verification-required': '请在斗鱼官方页面完成账号验证', unavailable: '暂时无法安全读取或操作斗鱼数据',
  'invalid-data': '斗鱼返回的数据不完整或无法确认', busy: '已有操作正在执行，请稍后重试',
  disabled: '截图和 GIF 功能已关闭', 'capture-busy': '已有 GIF 录制任务',
  'recording-not-found': '本次 GIF 录制已结束', 'capture-failed': '保存截图或 GIF 失败，请重试',
  'stream-limit': '同时播放的直播太多，请关闭一路再试', 'stream-not-found': '此直播已关闭',
  'stream-cancelled': '直播会话已关闭', 'source-unavailable': '直播源尚未就绪',
  'inventory-changed': '可赠库存已变化，已停止后续赠送', 'price-changed': '礼物价格或可赠状态已变化，已停止后续赠送',
  'balance-changed': '余额不足、无法确认或已变化，已停止后续赠送', 'stale-plan': '当前内容已失效，请重新生成',
} as const

export type FeatureErrorCode = keyof typeof ERROR_TEXT
export class FeatureApiError extends Error {
  constructor(readonly code: FeatureErrorCode) { super(ERROR_TEXT[code]); this.name = 'FeatureApiError' }
}
