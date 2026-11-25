import { describe, expect, it } from 'vitest'
import { clampAspectWindow, RESIZE_HANDLES, resizeAspectWindow, type AspectWindow } from './floatingWindow'

const stage = { width: 1000, height: 600 }
const aspect = 16 / 9
const bounds = { min: 0.1, max: 0.6 }

describe('floatingWindow 8-direction aspect-locked geometry', () => {
  const origin: AspectWindow = { x: 0.3, y: 0.3, width: 0.2 }
  const h0 = (origin.width * stage.width / aspect) / stage.height

  it('exposes all 8 resize handles', () => {
    expect(RESIZE_HANDLES).toEqual(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'])
  })

  it('anchors the opposite corner when resizing from each of the 4 corners', () => {
    const se = resizeAspectWindow(origin, 'se', 100, 20, stage, aspect, bounds)
    expect(se.x).toBeCloseTo(origin.x, 5)
    expect(se.y).toBeCloseTo(origin.y, 5)
    expect(se.width).toBeCloseTo(0.3, 5)

    const nw = resizeAspectWindow(origin, 'nw', -100, -20, stage, aspect, bounds)
    expect(nw.x + nw.width).toBeCloseTo(origin.x + origin.width, 5)
    const nwH = (nw.width * stage.width / aspect) / stage.height
    expect(nw.y + nwH).toBeCloseTo(origin.y + h0, 5)
    expect(nw.width).toBeCloseTo(0.3, 5)

    const ne = resizeAspectWindow(origin, 'ne', 80, -10, stage, aspect, bounds)
    expect(ne.x).toBeCloseTo(origin.x, 5)
    const neH = (ne.width * stage.width / aspect) / stage.height
    expect(ne.y + neH).toBeCloseTo(origin.y + h0, 5)
    expect(ne.width).toBeCloseTo(0.28, 5)

    const sw = resizeAspectWindow(origin, 'sw', -80, 10, stage, aspect, bounds)
    expect(sw.x + sw.width).toBeCloseTo(origin.x + origin.width, 5)
    expect(sw.y).toBeCloseTo(origin.y, 5)
    expect(sw.width).toBeCloseTo(0.28, 5)
  })

  it('anchors the opposite edge and centers perpendicularly on all 4 edges', () => {
    const cy0 = origin.y + h0 / 2
    const cx0 = origin.x + origin.width / 2

    const east = resizeAspectWindow(origin, 'e', 120, 0, stage, aspect, bounds)
    const eastH = (east.width * stage.width / aspect) / stage.height
    expect(east.x).toBeCloseTo(origin.x, 5)
    expect(east.width).toBeCloseTo(0.32, 5)
    expect(east.y + eastH / 2).toBeCloseTo(cy0, 5)

    const west = resizeAspectWindow(origin, 'w', -120, 0, stage, aspect, bounds)
    const westH = (west.width * stage.width / aspect) / stage.height
    expect(west.x + west.width).toBeCloseTo(origin.x + origin.width, 5)
    expect(west.width).toBeCloseTo(0.32, 5)
    expect(west.y + westH / 2).toBeCloseTo(cy0, 5)

    const south = resizeAspectWindow(origin, 's', 0, 45, stage, aspect, bounds)
    expect(south.y).toBeCloseTo(origin.y, 5)
    expect(south.width).toBeCloseTo((h0 * stage.height + 45) * aspect / stage.width, 5)
    expect(south.x + south.width / 2).toBeCloseTo(cx0, 5)

    const north = resizeAspectWindow(origin, 'n', 0, -45, stage, aspect, bounds)
    const northH = (north.width * stage.width / aspect) / stage.height
    expect(north.y + northH).toBeCloseTo(origin.y + h0, 5)
    expect(north.x + north.width / 2).toBeCloseTo(cx0, 5)
  })

  it('stops cleanly at stage boundaries without sliding the anchored corner', () => {
    const nearLeft: AspectWindow = { x: 0.05, y: 0.2, width: 0.2 }
    const rightEdge = nearLeft.x + nearLeft.width
    const clampedWest = resizeAspectWindow(nearLeft, 'w', -400, 0, stage, aspect, bounds)
    expect(clampedWest.x).toBeCloseTo(0, 5)
    expect(clampedWest.x + clampedWest.width).toBeCloseTo(rightEdge, 5)

    const clamped = clampAspectWindow({ x: 0.9, y: 0.9, width: 0.3 }, stage, aspect, bounds)
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(1.0001)
  })
})
