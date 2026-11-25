import { describe, expect, it } from 'vitest'
import { inplaceRect } from './CameraOverlay'

const box = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect

function video(width: number, height: number, rect: DOMRect): HTMLVideoElement {
  const element = document.createElement('video')
  Object.defineProperty(element, 'videoWidth', { value: width })
  Object.defineProperty(element, 'videoHeight', { value: height })
  element.getBoundingClientRect = () => rect
  return element
}

function stage(rect: DOMRect): HTMLElement {
  const element = document.createElement('div')
  element.getBoundingClientRect = () => rect
  return element
}

describe('画面透传 placement', () => {
  const crop = { x: 0.5, y: 0.25, w: 0.25, h: 0.5 }

  it('maps the crop onto a picture that fills the element', () => {
    expect(inplaceRect(stage(box(0, 0, 1600, 900)), video(1920, 1080, box(0, 0, 1600, 900)), crop))
      .toEqual({ left: 800, top: 225, width: 400, height: 450 })
  })

  it('skips the bars of a letterboxed picture', () => {
    // 1200x900 element, 16:9 picture => 1200x675 with 112.5 px bars top and bottom.
    expect(inplaceRect(stage(box(100, 50, 1400, 1000)), video(1920, 1080, box(200, 50, 1200, 900)), crop))
      .toEqual({ left: 100 + 600, top: 112.5 + 168.75, width: 300, height: 337.5 })
  })

  it('has no placement before the picture has a size', () => {
    expect(inplaceRect(stage(box(0, 0, 100, 100)), video(0, 0, box(0, 0, 100, 100)), crop)).toBeNull()
  })
})
