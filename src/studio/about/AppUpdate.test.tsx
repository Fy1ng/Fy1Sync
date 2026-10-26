/**
 * The release page button exists only for an available update, and the check button is held
 * while a check is in flight.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { AppUpdateState } from '../../../electron/appUpdateService'
import { AppUpdateSettings } from './AppUpdate'

type Call = { method: string; args: unknown }
let calls: Call[] = []
let initial: AppUpdateState
let checked: AppUpdateState
let release: (() => void) | null = null

const base: AppUpdateState = {
  phase: 'idle', currentVersion: '0.1.3', latestVersion: null, releaseUrl: null, releaseNotes: null, checkedAt: null,
  message: '手动检查应用版本更新.',
}

beforeEach(() => {
  calls = []
  initial = base
  checked = { ...base, phase: 'current', checkedAt: Date.UTC(2026, 9, 26), message: '已是最新版本.' }
  release = null
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      switch (method) {
        case 'getAppUpdateState': return { ok: true, value: initial }
        case 'checkAppUpdate':
          await new Promise<void>((resolve) => { release = resolve })
          return { ok: true, value: checked }
        case 'openAppReleasePage': return { ok: true, value: { opened: true } }
        default: return { ok: false, code: 'unknown', message: method }
      }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AppUpdateSettings', () => {
  it('shows the release button only once an update is available', async () => {
    checked = { ...base, phase: 'available', latestVersion: '0.2.0', releaseUrl: 'https://example.invalid/r', releaseNotes: '修复若干问题', checkedAt: 1, message: '发现新版本.' }
    render(<AppUpdateSettings />)
    expect(await screen.findByText('0.1.3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开发布页' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
    expect(await screen.findByRole('button', { name: '正在检查…' })).toBeDisabled()
    release!()
    const open = await screen.findByRole('button', { name: '打开发布页' })
    expect(screen.getByText('修复若干问题')).toBeInTheDocument()
    expect(screen.getByText('0.2.0')).toBeInTheDocument()
    fireEvent.click(open)
    await waitFor(() => expect(calls).toContainEqual({ method: 'openAppReleasePage', args: undefined }))
  })

  it('has no release button when current or unconfigured', async () => {
    render(<AppUpdateSettings />)
    fireEvent.click(await screen.findByRole('button', { name: '检查更新' }))
    await waitFor(() => expect(release).not.toBeNull())
    release!()
    expect(await screen.findByText('已是最新版本')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开发布页' })).toBeNull()
    cleanup()

    initial = { ...base, phase: 'unconfigured', message: '尚未配置本应用的可信发布源.' }
    render(<AppUpdateSettings />)
    expect(await screen.findByText('未配置发布源')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开发布页' })).toBeNull()
  })
})
