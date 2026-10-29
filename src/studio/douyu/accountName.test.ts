import { describe, expect, it } from 'vitest'
import { accountName } from './useDouyu'

describe('accountName', () => {
  it('shows the Douyu name once signed in', () => {
    expect(accountName({ id: 'default', label: '默认账号', login: { loggedIn: true, nickname: '解说甲' } })).toBe('解说甲')
  })

  it('gives the built-in account no name before login', () => {
    expect(accountName({ id: 'default', label: '默认账号', login: { loggedIn: false } })).toBe('')
    expect(accountName({ id: 'default', label: '默认账号', login: { loggedIn: true } })).toBe('')
  })

  it('keeps a label the viewer chose', () => {
    expect(accountName({ id: 'default', label: '主号', login: { loggedIn: false } })).toBe('主号')
    expect(accountName({ id: '0f1e2d3c-4b5a-4968-8776-655443322110', label: '小号', login: { loggedIn: false } })).toBe('小号')
  })
})
