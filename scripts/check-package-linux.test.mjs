import assert from 'node:assert/strict'
import test from 'node:test'
import { compareLinuxPayloadFiles } from './check-package-linux.mjs'

const payload = () => new Map([
  ['fy1sync', { size: 4, sha256: 'a'.repeat(64) }],
  ['resources/app.asar', { size: 8, sha256: 'b'.repeat(64) }],
  ['resources/apparmor-profile', { size: 12, sha256: 'c'.repeat(64) }],
])

test('DEB requires the exact AppArmor profile and complete application payload', () => {
  compareLinuxPayloadFiles(payload(), payload(), 'deb')
  const missing = payload()
  missing.delete('resources/apparmor-profile')
  assert.throws(() => compareLinuxPayloadFiles(payload(), missing, 'deb'))
})

test('standalone archives accept only the missing DEB-specific profile', () => {
  for (const format of ['AppImage', 'tar.gz']) {
    const actual = payload()
    actual.delete('resources/apparmor-profile')
    compareLinuxPayloadFiles(payload(), actual, format)
    actual.delete('resources/app.asar')
    assert.throws(() => compareLinuxPayloadFiles(payload(), actual, format))
  }
})

test('every present profile and shared application resource remains hash checked', () => {
  for (const format of ['deb', 'AppImage', 'tar.gz']) {
    for (const name of payload().keys()) {
      const actual = payload()
      actual.set(name, { size: 12, sha256: 'd'.repeat(64) })
      assert.throws(() => compareLinuxPayloadFiles(payload(), actual, format))
    }
  }
})

test('DEB and TAR reject undeclared payload files', () => {
  for (const format of ['deb', 'tar.gz']) {
    const actual = payload()
    actual.set('unexpected-file', { size: 1, sha256: 'e'.repeat(64) })
    assert.throws(() => compareLinuxPayloadFiles(payload(), actual, format))
  }
})
