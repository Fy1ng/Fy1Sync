import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { createEmptyHudStylePack } from '../../core/hudStylePack'
import { editorCue } from './cueModel'
import { LayoutSection } from './LayoutSection'

it('offers both lower resolution actions only for a 3840x2160 layout', () => {
  const pack = createEmptyHudStylePack('custom/layouts', '布局', { width: 3840, height: 2160 })
  const onGenerate = vi.fn()
  const props = { pack, variant: pack.variants[0]!, canCreate: false, onSelect: vi.fn(), onCreate: vi.fn(), onGenerate, onRename: () => null, onDelete: vi.fn() }
  const view = render(<LayoutSection {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '生成 1440p' }))
  fireEvent.click(screen.getByRole('button', { name: '生成 1080p' }))
  expect(onGenerate.mock.calls).toEqual([[1440], [1080]])
  view.rerender(<LayoutSection {...props} variant={{ ...props.variant, nativeSize: { width: 2560, height: 1440 } }} />)
  expect(screen.queryByRole('button', { name: '生成 1440p' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '生成 1080p' })).not.toBeInTheDocument()
})

it('warns when a competing same-size layout has no enabled organizer', () => {
  const pack = createEmptyHudStylePack()
  const variant = pack.variants[0]!
  pack.variants.push({ ...structuredClone(variant), id: 'second' })
  const props = { pack, variant, canCreate: false, onSelect: vi.fn(), onCreate: vi.fn(),
    onGenerate: vi.fn(), onRename: () => null, onDelete: vi.fn() }
  const view = render(<LayoutSection {...props} />)
  expect(screen.getByTestId('layout-organizer-warning')).toHaveTextContent('主办方未启用, 不会自动选中')
  variant.organizer = { ...editorCue(pack, 'organizer'), enabled: false }
  view.rerender(<LayoutSection {...props} />)
  expect(screen.getByTestId('layout-organizer-warning')).toHaveTextContent('主办方未启用, 不会自动选中')
  variant.organizer.enabled = true
  view.rerender(<LayoutSection {...props} />)
  expect(screen.queryByTestId('layout-organizer-warning')).not.toBeInTheDocument()
  expect(props.onSelect).not.toHaveBeenCalled()
  expect(pack.variants[1]!.organizer).toBeNull()
})

it('does not demand an organizer when no other layout has the same resolution', () => {
  const pack = createEmptyHudStylePack()
  const variant = pack.variants[0]!
  variant.organizer = { ...editorCue(pack, 'organizer'), enabled: false }
  const props = { pack, variant, canCreate: false, onSelect: vi.fn(), onCreate: vi.fn(),
    onGenerate: vi.fn(), onRename: () => null, onDelete: vi.fn() }
  const view = render(<LayoutSection {...props} />)
  expect(screen.queryByTestId('layout-organizer-warning')).not.toBeInTheDocument()
  pack.variants.push({ ...structuredClone(variant), id: 'small', nativeSize: { width: 1280, height: 720 } })
  view.rerender(<LayoutSection {...props} />)
  expect(screen.queryByTestId('layout-organizer-warning')).not.toBeInTheDocument()
  expect(screen.getByText(/多个候选需要主办方模板区分/)).toBeInTheDocument()
})

it('describes reference coordinates and proportional mapping without modifying the stored layout', () => {
  const pack = createEmptyHudStylePack('custom/reference', '参考布局', { width: 2560, height: 1440 })
  const original = JSON.stringify(pack)
  render(<LayoutSection pack={pack} variant={pack.variants[0]!} frameSize={{ width: 1920, height: 1080 }}
    canCreate onSelect={vi.fn()} onCreate={vi.fn()} onGenerate={vi.fn()} onRename={() => null} onDelete={vi.fn()} />)
  expect(screen.getByTestId('layout-reference-size')).toHaveTextContent('参考尺寸 2560x1440, 不限制录像分辨率')
  expect(screen.getByTestId('layout-scaled-frame')).toHaveTextContent('当前画面 1920x1080, 已按比例适配')
  expect(JSON.stringify(pack)).toBe(original)
})
