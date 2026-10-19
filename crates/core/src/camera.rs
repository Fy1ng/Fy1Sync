//! Streamer camera crop: tighten a rough user box to the camera's own rectangle.
//!
//! A webcam overlay on a commentary stream is a rectangle with a hard edge against the game
//! picture behind it. Inside the user's rough box that edge is the one straight line that
//! stays in the same place in every frame: game edges move with the camera and average out
//! over a few frames, the overlay border does not. Static HUD elements and furniture inside
//! the camera picture are also persistent, so the edges are chosen together by shape (see
//! below); a side without a clear edge stays where the user put it.

use serde::{Deserialize, Serialize};

use crate::{Image, RoiRect};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraTighten {
    pub roi: RoiRect,
    /// Which sides moved to a detected edge: left, top, right, bottom.
    pub found: [bool; 4],
}

/// Grayscale frames of the whole picture (all the same size) and a rough box in 0..1.
pub fn tighten_camera_box(frames: &[Image], rough: &RoiRect) -> CameraTighten {
    let unchanged = CameraTighten { roi: rough.clone(), found: [false; 4] };
    let Some(first) = frames.first() else { return unchanged };
    let (w, h) = (first.width, first.height);
    if w < 8 || h < 8 || frames.iter().any(|f| f.width != w || f.height != h || f.data.len() < w * h) {
        return unchanged;
    }
    let x0 = clamp_px(rough.x * w as f64, w);
    let y0 = clamp_px(rough.y * h as f64, h);
    let x1 = clamp_px((rough.x + rough.w) * w as f64, w);
    let y1 = clamp_px((rough.y + rough.h) * h as f64, h);
    if x1 <= x0 + 8 || y1 <= y0 + 8 {
        return unchanged;
    }

    // Mean absolute step across each column boundary (vertical edges) and row boundary
    // (horizontal edges), summed only along the box's extent on the other axis and averaged
    // over frames. `columns[i]` is the edge between x0+i and x0+i+1.
    let mut columns = vec![0.0f64; x1 - x0 - 1];
    let mut rows = vec![0.0f64; y1 - y0 - 1];
    for frame in frames {
        let px = |x: usize, y: usize| frame.data[y * w + x] as f64;
        for (i, slot) in columns.iter_mut().enumerate() {
            let x = x0 + i;
            let mut sum = 0.0;
            for y in y0..y1 {
                sum += (px(x + 1, y) - px(x, y)).abs();
            }
            *slot += sum / (y1 - y0) as f64;
        }
        for (i, slot) in rows.iter_mut().enumerate() {
            let y = y0 + i;
            let mut sum = 0.0;
            for x in x0..x1 {
                sum += (px(x, y + 1) - px(x, y)).abs();
            }
            *slot += sum / (x1 - x0) as f64;
        }
    }
    let n = frames.len() as f64;
    columns.iter_mut().for_each(|v| *v /= n);
    rows.iter_mut().for_each(|v| *v /= n);

    // Each side searches its outer 40% of the box: the user drew around the camera, so its
    // edge is nearer that side than the opposite one. Every side also keeps the user's own
    // line as a candidate, for a camera that touches the frame edge and has none.
    let band = |len: usize| ((len as f64) * 0.4).ceil() as usize;
    let lead = |profile: &[f64]| candidates(profile, 0, band(profile.len()), -1);
    let trail = |profile: &[f64]| candidates(profile, profile.len().saturating_sub(band(profile.len())), profile.len(), 1);
    // Edge index i lies between pixels i and i+1: the camera starts at i+1 on the leading
    // sides and ends at i (inclusive) on the trailing ones.
    let side = |found: Vec<usize>, origin: usize, rough: usize| -> Vec<(usize, bool)> {
        let mut out: Vec<(usize, bool)> = found.into_iter().map(|i| (origin + i + 1, true)).collect();
        out.push((rough, false));
        out
    };
    let lefts = side(lead(&columns), x0, x0);
    let rights = side(trail(&columns), x0, x1);
    let tops = side(lead(&rows), y0, y0);
    let bottoms = side(trail(&rows), y0, y1);

    // Persistence alone cannot tell the camera from other static furniture: a game HUD bar
    // beside it, or a door frame inside its picture, is just as still. What sets the camera
    // apart is its shape — webcams are 16:9 or 4:3 — so among all combinations of candidate
    // edges, take the one closest to either, then the one with more real edges, then the
    // larger. Real Douyu frames: border plus HUD gave 226x182; this picks 226x127 (16:9).
    let mut best: Option<(f64, usize, usize, [usize; 4], [bool; 4])> = None;
    for &(l, lf) in &lefts {
        for &(r, rf) in &rights {
            if r <= l + 8 {
                continue;
            }
            for &(t, tf) in &tops {
                for &(bo, bf) in &bottoms {
                    if bo <= t + 8 {
                        continue;
                    }
                    let aspect = (r - l) as f64 / (bo - t) as f64;
                    // 4:3 carries a small penalty: when both shapes fit (a 16:9 camera above
                    // a static HUD card also makes a 4:3 box), the common webcam shape wins.
                    let error = ((aspect / (16.0 / 9.0)).ln().abs()).min((aspect / (4.0 / 3.0)).ln().abs() + 0.035);
                    let found = [lf, tf, rf, bf];
                    let count = found.iter().filter(|f| **f).count();
                    let area = (r - l) * (bo - t);
                    // Aspect errors within 3% are treated as equal so edge count decides.
                    let bucket = (error / 0.03).floor();
                    let better = match &best {
                        None => true,
                        Some((e, c, a, _, _)) => {
                            let eb = (e / 0.03).floor();
                            bucket < eb || (bucket == eb && (count > *c || (count == *c && area > *a)))
                        }
                    };
                    if better {
                        best = Some((error, count, area, [l, t, r, bo], found));
                    }
                }
            }
        }
    }
    let Some((error, count, _, [nx0, ny0, nx1, ny1], found)) = best else { return unchanged };
    // Nothing found, or not a webcam shape: the user's box is the better answer. 6% is wide
    // enough for encoder rounding (the real camera above is 0.1% off 16:9) and narrow enough
    // to refuse a box cut through the picture (10% off on the synthetic test).
    if count == 0 || error > (1.06f64).ln() {
        return unchanged;
    }
    CameraTighten {
        roi: RoiRect {
            x: nx0 as f64 / w as f64,
            y: ny0 as f64 / h as f64,
            w: (nx1 - nx0) as f64 / w as f64,
            h: (ny1 - ny0) as f64 / h as f64,
        },
        found,
    }
}

fn clamp_px(value: f64, limit: usize) -> usize {
    if !value.is_finite() {
        return 0;
    }
    (value.round().max(0.0) as usize).min(limit)
}

/// Clear edges in `profile[from..to]`, strongest per neighbourhood, at most four.
///
/// "Clear" means well above the profile's typical level (median over the whole box) and in
/// absolute terms visible: a hard overlay edge is a step of tens of grey levels along most
/// of its length, where averaged game texture sits at a few. A border is two adjacent
/// edges; suppression within 3 px keeps one of them, the one further out (`outward` is
/// -1 for leading sides, +1 for trailing) so the border stays in the crop.
fn candidates(profile: &[f64], from: usize, to: usize, outward: i32) -> Vec<usize> {
    if from >= to || to > profile.len() {
        return vec![];
    }
    let mut sorted = profile.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let median = sorted[sorted.len() / 2];
    let threshold = (median * 3.0 + 4.0).max(12.0);
    let mut peaks: Vec<usize> = (from..to).filter(|&i| profile[i] >= threshold).collect();
    peaks.sort_by(|&a, &b| profile[b].total_cmp(&profile[a]));
    // (anchor, chosen): neighbours are compared with the anchor, never with an earlier
    // replacement, so a run of weak edges cannot walk the choice outward step by step.
    let mut kept: Vec<(usize, usize)> = vec![];
    for i in peaks {
        if let Some(entry) = kept.iter_mut().find(|(anchor, _)| anchor.abs_diff(i) <= 3) {
            let further = (outward < 0 && i < entry.1) || (outward > 0 && i > entry.1);
            if further && profile[i] >= profile[entry.0] * 0.5 {
                entry.1 = i
            }
        } else if kept.len() < 4 {
            kept.push((i, i))
        }
    }
    kept.into_iter().map(|(_, chosen)| chosen).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 320x180 frame: textured "game" everywhere, a camera rectangle at
    /// (100..220, 60..150) with a 2 px light border and moving content inside.
    fn frame(seed: u32, camera: bool) -> Image {
        let (w, h) = (320usize, 180usize);
        let mut data = vec![0u8; w * h];
        let mut state = seed.wrapping_mul(2654435761).wrapping_add(1);
        for (i, px) in data.iter_mut().enumerate() {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let (x, y) = (i % w, i / w);
            // Game: shifting diagonal stripes plus noise, so no edge is persistent.
            let stripe = (((x + y + seed as usize * 7) / 9) % 2) as u32 * 60;
            *px = (60 + stripe + (state % 40)) as u8;
        }
        if camera {
            for y in 60..150 {
                for x in 100..220 {
                    let border = x < 102 || x >= 218 || y < 62 || y >= 148;
                    data[y * w + x] = if border { 235 } else { (20 + ((x * 3 + y + seed as usize * 11) % 50)) as u8 };
                }
            }
        }
        Image { data, width: w, height: h }
    }

    fn same(a: &RoiRect, b: &RoiRect) -> bool {
        a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h
    }

    fn px(roi: &RoiRect) -> (i64, i64, i64, i64) {
        let r = |v: f64| v.round() as i64;
        (r(roi.x * 320.0), r(roi.y * 180.0), r((roi.x + roi.w) * 320.0), r((roi.y + roi.h) * 180.0))
    }

    #[test]
    fn tightens_a_loose_box_to_the_camera_rectangle() {
        let frames: Vec<_> = (0..6).map(|s| frame(s, true)).collect();
        let rough = RoiRect { x: 80.0 / 320.0, y: 45.0 / 180.0, w: 165.0 / 320.0, h: 120.0 / 180.0 };
        let result = tighten_camera_box(&frames, &rough);
        assert_eq!(result.found, [true; 4]);
        let (x0, y0, x1, y1) = px(&result.roi);
        assert!((x0 - 100).abs() <= 1 && (y0 - 60).abs() <= 1, "{:?}", px(&result.roi));
        assert!((x1 - 220).abs() <= 1 && (y1 - 150).abs() <= 1, "{:?}", px(&result.roi));
    }

    #[test]
    fn keeps_the_rough_box_when_there_is_no_persistent_edge() {
        let frames: Vec<_> = (0..6).map(|s| frame(s, false)).collect();
        let rough = RoiRect { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
        let result = tighten_camera_box(&frames, &rough);
        assert_eq!(result.found, [false; 4]);
        assert!(same(&result.roi, &rough));
    }

    #[test]
    fn a_side_drawn_inside_the_camera_is_not_pushed_outward() {
        let frames: Vec<_> = (0..6).map(|s| frame(s, true)).collect();
        // Right side drawn at 200, inside the camera (which ends at 220). There is no edge in
        // that band, so the right side stays exactly where the user put it.
        let rough = RoiRect { x: 80.0 / 320.0, y: 45.0 / 180.0, w: 120.0 / 320.0, h: 120.0 / 180.0 };
        let result = tighten_camera_box(&frames, &rough);
        assert!(!result.found[2]);
        assert_eq!(px(&result.roi).2, 200);
        let (_, y0, _, y1) = px(&result.roi);
        assert!((y0 - 60).abs() <= 1 && (y1 - 150).abs() <= 1);
    }

    #[test]
    fn prefers_the_webcam_shape_over_a_static_hud_edge() {
        // A static bright bar right under the camera (a HUD strip) is as persistent as the
        // camera border; the 4:3 box must win over the taller box that includes the bar.
        let frames: Vec<_> = (0..6)
            .map(|s| {
                let mut f = frame(s, true);
                for y in 150..165 {
                    for x in 100..220 {
                        f.data[y * 320 + x] = 200;
                    }
                }
                f
            })
            .collect();
        let rough = RoiRect { x: 85.0 / 320.0, y: 48.0 / 180.0, w: 150.0 / 320.0, h: 125.0 / 180.0 };
        let (x0, y0, x1, y1) = px(&tighten_camera_box(&frames, &rough).roi);
        // The bar is flush with the border, so the inner border edge may win by 2 px; what
        // matters is that the bar (to 165) is not taken in.
        assert!((x0 - 100).abs() <= 1 && (y0 - 60).abs() <= 1 && (x1 - 220).abs() <= 1 && (y1 - 150).abs() <= 3, "{:?}", (x0, y0, x1, y1));
    }

    #[test]
    fn rejects_degenerate_input() {
        let rough = RoiRect { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
        assert!(same(&tighten_camera_box(&[], &rough).roi, &rough));
        let tiny = RoiRect { x: 0.5, y: 0.5, w: 0.001, h: 0.001 };
        assert!(same(&tighten_camera_box(&[frame(0, true)], &tiny).roi, &tiny));
        let mismatched = vec![frame(0, true), Image { data: vec![0; 16], width: 4, height: 4 }];
        assert_eq!(tighten_camera_box(&mismatched, &rough).found, [false; 4]);
    }
}
