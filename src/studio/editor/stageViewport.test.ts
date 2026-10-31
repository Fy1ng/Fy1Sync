import { describe, expect, it } from 'vitest'
import { pointToFraction } from '../../core/imageOps'
import { FIT_VIEW, fitScale, focusRoi, panView, pictureRect, zoomAt } from './stageViewport'

const media = { width: 3840, height: 2160 }
const viewport = { width: 1100, height: 700 }

describe('editor picture coordinates', () => {
  it('keeps the mouse fraction stationary through zoom and translates screen panning into picture fractions', () => {
    const point = { x: 630, y: 140 }
    const fit = pictureRect(media, viewport, FIT_VIEW)
    const before = pointToFraction(point, fit)
    const zoom = zoomAt(media, viewport, FIT_VIEW, 3, point)
    const enlarged = pictureRect(media, viewport, zoom)
    const after = pointToFraction(point, enlarged)
    expect(after.x).toBeCloseTo(before.x, 10)
    expect(after.y).toBeCloseTo(before.y, 10)
    const panned = pictureRect(media, viewport, panView(zoom, enlarged, 120, -60))
    expect(panned.x).toBeCloseTo(enlarged.x + 120)
    expect(panned.y).toBeCloseTo(enlarged.y - 60)
    expect(pointToFraction({ x: point.x + 120, y: point.y - 60 }, panned)).toEqual(after)
  })

  it('focuses an edge ROI at the viewport center with a four-native-pixel ceiling', () => {
    const roi = { x: 1850 / 3840, y: 96 / 2160, w: 116 / 3840, h: 64 / 2160 }
    const focused = focusRoi(media, viewport, roi)
    const rect = pictureRect(media, viewport, focused)
    expect(fitScale(media, viewport) * focused.zoom).toBeCloseTo(4)
    expect(rect.x + (roi.x + roi.w / 2) * rect.width).toBeCloseTo(viewport.width / 2)
    expect(rect.y + (roi.y + roi.h / 2) * rect.height).toBeCloseTo(viewport.height / 2)
    expect(roi.w * rect.width).toBeCloseTo(464)
    const large = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
    const largeRect = pictureRect(media, viewport, focusRoi(media, viewport, large))
    expect(largeRect.width * large.w).toBeCloseTo(viewport.width * 0.8)
  })

  it('bounds wheel zoom and restores the centered letterbox at fit', () => {
    const maximum = zoomAt(media, viewport, FIT_VIEW, 1000, { x: 550, y: 350 })
    expect(maximum.zoom * fitScale(media, viewport)).toBeCloseTo(4)
    const fit = zoomAt(media, viewport, maximum, 0.0001, { x: 80, y: 50 })
    expect(fit).toEqual(FIT_VIEW)
    expect(pictureRect(media, viewport, fit)).toEqual({ x: 0, y: 40.625, width: 1100, height: 618.75 })
    expect(panView(FIT_VIEW, pictureRect(media, viewport, FIT_VIEW), 100, 100)).toEqual(FIT_VIEW)
  })
})
