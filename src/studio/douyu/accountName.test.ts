import { describe, expect, it } from 'vitest'
import { accountName } from './useDouyu'

describe('accountName', () => {
  it('shows the Douyu name once signed in', () => {
    expect(accountName({ login: { loggedIn: true, nickname: '解说甲' } })).toBe('解说甲')
  })

  it('gives an account no name before login or when nickname is absent', () => {
    expect(accountName({ login: { loggedIn: false } })).toBe('')
    expect(accountName({ login: { loggedIn: false, nickname: '解说甲' } })).toBe('')
    expect(accountName({ login: { loggedIn: true } })).toBe('')
  })

  it('ignores local fallback or legacy custom labels', () => {
    const withDefault = { id: 'default', label: '默认账号', login: { loggedIn: false } }
    const withLegacy = { id: '0f1e2d3c-4b5a-4968-8776-655443322110', label: '小号', login: { loggedIn: false } }
    expect(accountName(withDefault)).toBe('')
    expect(accountName(withLegacy)).toBe('')
  })
})
