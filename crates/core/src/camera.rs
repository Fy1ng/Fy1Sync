//! Streamer camera crop: tighten a rough user box to the camera's own rectangle.
//!
//! A webcam overlay on a commentary stream is a rectangle with a hard edge against the game
//! picture behind it. Inside the user's rough box that edge is the one straight line that
//! stays in the same place in every frame: game edges move with the camera and average out
//! over a few frames, the overlay border does not. Static HUD elements and furniture inside
//! the camera picture are also persistent. Finite line support, corner closure and the
//! outer supported rectangle distinguish them without assuming a fixed camera aspect ratio.

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
    let unchanged = CameraTighten {
        roi: rough.clone(),
        found: [false; 4],
    };
    let Some(first) = frames.first() else {
        return unchanged;
    };
    let (w, h) = (first.width, first.height);
    if w < 8
        || h < 8
        || frames
            .iter()
            .any(|f| f.width != w || f.height != h || f.data.len() < w * h)
    {
        return unchanged;
    }
    let [l, t, r, b] = [
        clamp_px(rough.x * w as f64, w),
        clamp_px(rough.y * h as f64, h),
        clamp_px((rough.x + rough.w) * w as f64, w),
        clamp_px((rough.y + rough.h) * h as f64, h),
    ];
    if r <= l + 8 || b <= t + 8 {
        return unchanged;
    }
    let vertical = Lines::new(frames, [l, t, r, b], true);
    let horizontal = Lines::new(frames, [l, t, r, b], false);
    let mut lefts = vertical.candidates(-1);
    lefts.push(l);
    let mut rights = vertical.candidates(1);
    rights.push(r);
    let mut tops = horizontal.candidates(-1);
    tops.push(t);
    let mut bottoms = horizontal.candidates(1);
    bottoms.push(b);
    let mut best: Option<(usize, f64, [usize; 4])> = None;
    for &nl in &lefts {
        for &nr in &rights {
            if nr <= nl + 12 {
                continue;
            }
            for &nt in &tops {
                for &nb in &bottoms {
                    if nb <= nt + 12 {
                        continue;
                    }
                    let aspect = (nr - nl) as f64 / (nb - nt) as f64;
                    if !(0.45..=3.2).contains(&aspect) {
                        continue;
                    }
                    let sides = [
                        vertical.evidence(nl, nt, nb),
                        horizontal.evidence(nt, nl, nr),
                        vertical.evidence(nr, nt, nb),
                        horizontal.evidence(nb, nl, nr),
                    ];
                    let moved = [nl != l, nt != t, nr != r, nb != b];
                    let count = moved.iter().filter(|&&m| m).count();
                    if count == 0 || sides.iter().zip(moved).any(|(e, m)| m && e.is_none()) {
                        continue;
                    }
                    let frame_sides = [nl == 0, nt == 0, nr == w, nb == h];
                    let supported = sides.iter().filter(|e| e.is_some()).count()
                        + frame_sides.iter().filter(|&&f| f).count();
                    if supported < 3 {
                        continue;
                    }
                    let quality: Vec<_> = sides.iter().flatten().copied().collect();
                    let weakest = quality.iter().copied().fold(f64::INFINITY, f64::min);
                    let mean = quality.iter().sum::<f64>() / quality.len() as f64;
                    // A modest border-closure tie-break, without imposing a webcam aspect ratio.
                    let corners = [(nl, nt), (nr - 1, nt), (nl, nb - 1), (nr - 1, nb - 1)];
                    let levels: Vec<f64> = corners
                        .iter()
                        .map(|&(x, y)| {
                            frames.iter().map(|f| f.data[y * w + x] as f64).sum::<f64>()
                                / frames.len() as f64
                        })
                        .collect();
                    let spread = levels.iter().copied().fold(0.0, f64::max)
                        - levels.iter().copied().fold(255.0, f64::min);
                    // Prefer the outer supported rectangle to a closed piece of furniture inside
                    // it. This only ranks rectangles whose individual sides already passed.
                    let retained_area = ((nr - nl) * (nb - nt)) as f64 / ((r - l) * (b - t)) as f64;
                    let score = weakest
                        + mean * 0.15
                        + 0.6 * (-spread / 20.0).exp()
                        + retained_area.ln() * 1.8;
                    // A supported fourth side outranks arbitrary extra rough-box area.
                    // Only compare area/strength after the actual support count agrees.
                    if best.as_ref().is_none_or(|(previous_support, previous, _)| {
                        supported > *previous_support
                            || (supported == *previous_support && score > *previous)
                    }) {
                        best = Some((supported, score, [nl, nt, nr, nb]));
                    }
                }
            }
        }
    }
    let Some((_, _, [nl, nt, nr, nb])) = best else {
        return unchanged;
    };
    // Keep undetected sides in the user's original normalized coordinates. Rounding to
    // analysis pixels must not move a fractional rough side or appear to expand it.
    let nx = if nl == l {
        rough.x
    } else {
        nl as f64 / w as f64
    };
    let ny = if nt == t {
        rough.y
    } else {
        nt as f64 / h as f64
    };
    let right = if nr == r {
        rough.x + rough.w
    } else {
        nr as f64 / w as f64
    };
    let bottom = if nb == b {
        rough.y + rough.h
    } else {
        nb as f64 / h as f64
    };
    CameraTighten {
        roi: RoiRect {
            x: nx,
            y: ny,
            w: right - nx,
            h: bottom - ny,
        },
        found: [nl != l, nt != t, nr != r, nb != b],
    }
}

/// Prefix sums along finite lines. A lower temporal quartile rejects moving game edges.
/// Each side is tested over the candidate rectangle, never over the whole rough box.
struct Lines {
    origin: usize,
    start: usize,
    length: usize,
    sums: Vec<Vec<f64>>,
    hits: Vec<Vec<usize>>,
    threshold: f64,
}
impl Lines {
    fn new(frames: &[Image], [l, t, r, b]: [usize; 4], vertical: bool) -> Self {
        // Include the rough sides themselves: an already aligned side can provide real
        // support even though it does not move. Frame-edge sides are known separately.
        let (origin, end, start, stop) = if vertical {
            (l.saturating_sub(1), (r + 1).min(frames[0].width), t, b)
        } else {
            (t.saturating_sub(1), (b + 1).min(frames[0].height), l, r)
        };
        let length = stop - start;
        let mut gradients = vec![vec![0.0; length]; end - origin - 1];
        let mut typical = Vec::with_capacity(gradients.len() * length);
        for (i, line) in gradients.iter_mut().enumerate() {
            let edge = origin + i + 1;
            for (j, value) in line.iter_mut().enumerate() {
                let point = start + j;
                let mut samples: Vec<u8> = frames
                    .iter()
                    .map(|f| {
                        let (a, z) = if vertical {
                            (point * f.width + edge - 1, point * f.width + edge)
                        } else {
                            ((edge - 1) * f.width + point, edge * f.width + point)
                        };
                        f.data[a].abs_diff(f.data[z])
                    })
                    .collect();
                samples.sort_unstable();
                *value = samples[(samples.len() - 1) / 4] as f64;
                typical.push(*value);
            }
        }
        typical.sort_by(f64::total_cmp);
        let threshold = (typical[typical.len() / 2] * 2.5).max(8.0);
        let mut sums = Vec::new();
        let mut hits = Vec::new();
        for line in gradients {
            let mut sum = vec![0.0; length + 1];
            let mut hit = vec![0; length + 1];
            for (i, g) in line.into_iter().enumerate() {
                // Bound the influence of bright HUD pixels on a weak camera edge.
                sum[i + 1] = sum[i]
                    + if g >= threshold {
                        g.min(threshold * 4.0)
                    } else {
                        0.0
                    };
                hit[i + 1] = hit[i] + usize::from(g >= threshold);
            }
            sums.push(sum);
            hits.push(hit);
        }
        Self {
            origin,
            start,
            length,
            sums,
            hits,
            threshold,
        }
    }
    fn evidence(&self, edge: usize, from: usize, to: usize) -> Option<f64> {
        if edge <= self.origin
            || edge > self.origin + self.sums.len()
            || from < self.start
            || to > self.start + self.length
            || to <= from
        {
            return None;
        }
        let i = edge - self.origin - 1;
        let a = from - self.start;
        let b = to - self.start;
        let span = (b - a) as f64;
        let coverage = (self.hits[i][b] - self.hits[i][a]) as f64 / span;
        let mean = (self.sums[i][b] - self.sums[i][a]) / span;
        let corner = ((b - a) / 8).max(3).min((b - a) / 2);
        let leading = (self.hits[i][a + corner] - self.hits[i][a]) as f64 / corner as f64;
        let trailing = (self.hits[i][b] - self.hits[i][b - corner]) as f64 / corner as f64;
        // Borderless black camera content can blend into a black game scene in the middle
        // of a side. Both endpoints must still meet the other sides, rather than treating
        // one short furniture line as a complete edge.
        if coverage < 0.35 || leading < 0.6 || trailing < 0.6 || mean < self.threshold {
            None
        } else {
            Some((mean / self.threshold).ln_1p() * coverage)
        }
    }
    fn candidates(&self, outward: i32) -> Vec<usize> {
        // Candidate discovery must see a short visible segment even when the rest of a
        // borderless side blends into the background. Full-side and endpoint tests above
        // still decide whether this line can belong to a rectangle.
        let window = 12.min(self.length);
        let mut scores: Vec<(usize, f64)> = self
            .sums
            .iter()
            .enumerate()
            .filter_map(|(i, sums)| {
                let mut score: f64 = 0.0;
                for a in 0..=self.length - window {
                    let b = a + window;
                    if (self.hits[i][b] - self.hits[i][a]) as f64 >= window as f64 * 0.7 {
                        score = score.max((sums[b] - sums[a]) / window as f64);
                    }
                }
                (score >= self.threshold).then_some((i, score))
            })
            .collect();
        scores.sort_by(|a, b| b.1.total_cmp(&a.1));
        let mut kept: Vec<(usize, usize, f64)> = Vec::new();
        for (i, score) in scores {
            if let Some((_, chosen, strongest)) =
                kept.iter_mut().find(|(a, _, _)| a.abs_diff(i) <= 3)
            {
                if score >= *strongest * 0.5
                    && ((outward < 0 && i < *chosen) || (outward > 0 && i > *chosen))
                {
                    *chosen = i;
                }
            } else if kept.len() < 16 {
                kept.push((i, i, score));
            }
        }
        // Keep the strongest boundary as well as the outward one. Compression may put a
        // short bright fragment one pixel farther out; rectangle support decides which
        // actually spans the full side instead of discarding the correct boundary here.
        kept.into_iter()
            .flat_map(|(anchor, chosen, _)| {
                if anchor == chosen {
                    vec![self.origin + chosen + 1]
                } else {
                    vec![self.origin + chosen + 1, self.origin + anchor + 1]
                }
            })
            .collect()
    }
}

fn clamp_px(value: f64, limit: usize) -> usize {
    if !value.is_finite() {
        return 0;
    }
    (value.round().max(0.0) as usize).min(limit)
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
                    data[y * w + x] = if border {
                        235
                    } else {
                        (20 + ((x * 3 + y + seed as usize * 11) % 50)) as u8
                    };
                }
            }
        }
        Image {
            data,
            width: w,
            height: h,
        }
    }

    fn same(a: &RoiRect, b: &RoiRect) -> bool {
        a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h
    }

    fn px(roi: &RoiRect) -> (i64, i64, i64, i64) {
        let r = |v: f64| v.round() as i64;
        (
            r(roi.x * 320.0),
            r(roi.y * 180.0),
            r((roi.x + roi.w) * 320.0),
            r((roi.y + roi.h) * 180.0),
        )
    }

    #[test]
    fn tightens_a_loose_box_to_the_camera_rectangle() {
        let frames: Vec<_> = (0..6).map(|s| frame(s, true)).collect();
        let rough = RoiRect {
            x: 80.0 / 320.0,
            y: 45.0 / 180.0,
            w: 165.0 / 320.0,
            h: 120.0 / 180.0,
        };
        let result = tighten_camera_box(&frames, &rough);
        assert_eq!(result.found, [true; 4]);
        let (x0, y0, x1, y1) = px(&result.roi);
        assert!(
            (x0 - 100).abs() <= 1 && (y0 - 60).abs() <= 1,
            "{:?}",
            px(&result.roi)
        );
        assert!(
            (x1 - 220).abs() <= 1 && (y1 - 150).abs() <= 1,
            "{:?}",
            px(&result.roi)
        );
    }

    #[test]
    fn keeps_the_rough_box_when_there_is_no_persistent_edge() {
        let frames: Vec<_> = (0..6).map(|s| frame(s, false)).collect();
        let rough = RoiRect {
            x: 0.25,
            y: 0.25,
            w: 0.5,
            h: 0.5,
        };
        let result = tighten_camera_box(&frames, &rough);
        assert_eq!(result.found, [false; 4]);
        assert!(same(&result.roi, &rough));
    }

    #[test]
    fn a_side_drawn_inside_the_camera_is_not_pushed_outward() {
        let frames: Vec<_> = (0..6).map(|s| frame(s, true)).collect();
        // Right side drawn at 200, inside the camera (which ends at 220). There is no edge in
        // that band, so the right side stays exactly where the user put it.
        let rough = RoiRect {
            x: 80.0 / 320.0,
            y: 45.0 / 180.0,
            w: 120.0 / 320.0,
            h: 120.0 / 180.0,
        };
        let result = tighten_camera_box(&frames, &rough);
        assert!(!result.found[2]);
        assert_eq!(px(&result.roi).2, 200);
        let (_, y0, _, y1) = px(&result.roi);
        assert!((y0 - 60).abs() <= 1 && (y1 - 150).abs() <= 1);
    }

    #[test]
    fn an_undetected_fractional_side_keeps_its_original_coordinate() {
        let frames: Vec<_> = (0..6).map(|s| frame(s, true)).collect();
        let rough = RoiRect {
            x: 80.25 / 320.0,
            y: 45.45 / 180.0,
            w: 120.06 / 320.0,
            h: 120.18 / 180.0,
        };
        let result = tighten_camera_box(&frames, &rough);
        assert!(!result.found[2]);
        assert_eq!(result.roi.x + result.roi.w, rough.x + rough.w);
        assert!(result.roi.x >= rough.x && result.roi.y >= rough.y);
        assert!(result.roi.y + result.roi.h <= rough.y + rough.h);
    }

    #[test]
    fn three_already_aligned_sides_support_tightening_the_fourth() {
        let frames: Vec<_> = (0..6).map(|s| frame(s, true)).collect();
        let rough = RoiRect {
            x: 100.0 / 320.0,
            y: 60.0 / 180.0,
            w: 120.0 / 320.0,
            h: 105.0 / 180.0,
        };
        let result = tighten_camera_box(&frames, &rough);
        assert_eq!(result.found, [false, false, false, true]);
        assert_eq!(px(&result.roi), (100, 60, 220, 150));
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
        let rough = RoiRect {
            x: 85.0 / 320.0,
            y: 48.0 / 180.0,
            w: 150.0 / 320.0,
            h: 125.0 / 180.0,
        };
        let (x0, y0, x1, y1) = px(&tighten_camera_box(&frames, &rough).roi);
        // The bar is flush with the border, so the inner border edge may win by 2 px; what
        // matters is that the bar (to 165) is not taken in.
        assert!(
            (x0 - 100).abs() <= 1
                && (y0 - 60).abs() <= 1
                && (x1 - 220).abs() <= 1
                && (y1 - 150).abs() <= 3,
            "{:?}",
            (x0, y0, x1, y1)
        );
    }

    #[test]
    fn rejects_degenerate_input() {
        let rough = RoiRect {
            x: 0.1,
            y: 0.1,
            w: 0.2,
            h: 0.2,
        };
        assert!(same(&tighten_camera_box(&[], &rough).roi, &rough));
        let tiny = RoiRect {
            x: 0.5,
            y: 0.5,
            w: 0.001,
            h: 0.001,
        };
        assert!(same(
            &tighten_camera_box(&[frame(0, true)], &tiny).roi,
            &tiny
        ));
        let mismatched = vec![
            frame(0, true),
            Image {
                data: vec![0; 16],
                width: 4,
                height: 4,
            },
        ];
        assert_eq!(tighten_camera_box(&mismatched, &rough).found, [false; 4]);
    }

    // Weak, short sides vanish when averaged over the full height/width of a wide rough
    // box. These coordinates are fixture truth, independent of the detector's profiles.
    fn weak_frame(seed: usize, camera: [usize; 4], hud: bool) -> Image {
        let (w, h) = (480, 270);
        let [l, t, r, b] = camera;
        let mut data = vec![0; w * h];
        for y in 0..h {
            for x in 0..w {
                data[y * w + x] = (98 + ((x + y * 3 + seed * 19) % 23)) as u8;
                if x >= l && x < r && y >= t && y < b {
                    let border = x == l || x + 1 == r || y == t || y + 1 == b;
                    data[y * w + x] = if border {
                        140
                    } else {
                        (110 + ((x * 2 + y + seed * 7) % 21)) as u8
                    };
                    // A static vertical object inside the webcam is stronger than its edge.
                    if x == l + 25 && y > t + 5 && y + 5 < b {
                        data[y * w + x] = 220;
                    }
                }
                if hud && x >= l && x < r && y >= b + 6 && y < b + 22 {
                    data[y * w + x] = 210;
                }
            }
        }
        Image {
            width: w,
            height: h,
            data,
        }
    }

    #[test]
    fn short_weak_edges_survive_a_wide_rough_box_and_static_furniture() {
        let truth = [172, 110, 300, 182];
        let frames: Vec<_> = (0..6).map(|s| weak_frame(s, truth, false)).collect();
        let rough = RoiRect {
            x: 40.0 / 480.0,
            y: 30.0 / 270.0,
            w: 370.0 / 480.0,
            h: 210.0 / 270.0,
        };
        assert_camera_truth(&tighten_camera_box(&frames, &rough), truth, 2);
    }

    #[test]
    fn weak_camera_is_not_extended_to_a_brighter_detached_hud() {
        let truth = [100, 95, 260, 185];
        let frames: Vec<_> = (0..6).map(|s| weak_frame(s, truth, true)).collect();
        let rough = RoiRect {
            x: 60.0 / 480.0,
            y: 50.0 / 270.0,
            w: 250.0 / 480.0,
            h: 185.0 / 270.0,
        };
        assert_camera_truth(&tighten_camera_box(&frames, &rough), truth, 2);
    }

    #[test]
    fn a_borderless_side_can_blend_in_the_middle_but_must_close_at_both_ends() {
        let truth = [172, 110, 300, 182];
        let frames: Vec<_> = (0..6)
            .map(|s| {
                let mut f = weak_frame(s, truth, false);
                // Most of the right boundary shares the background level. Its endpoint
                // segments remain visible; unrelated interior lines are still stronger.
                for y in 116..158 {
                    f.data[y * 480 + 299] = f.data[y * 480 + 300];
                }
                // A short bright fragment next to the bottom must not suppress the true
                // full-length boundary before the rectangle support test runs.
                for x in 200..216 {
                    f.data[182 * 480 + x] = 240;
                }
                f
            })
            .collect();
        let rough = RoiRect {
            x: 100.0 / 480.0,
            y: 65.0 / 270.0,
            w: 270.0 / 480.0,
            h: 165.0 / 270.0,
        };
        assert_camera_truth(&tighten_camera_box(&frames, &rough), truth, 2);
    }

    #[test]
    fn outer_weak_side_beats_a_complete_stronger_furniture_partition() {
        let truth = [172, 110, 300, 182];
        let frames: Vec<_> = (0..6)
            .map(|s| {
                let mut f = weak_frame(s, truth, false);
                for y in 110..182 {
                    f.data[y * 480 + 234] = 220;
                }
                for y in 116..158 {
                    f.data[y * 480 + 299] = f.data[y * 480 + 300];
                }
                f
            })
            .collect();
        let rough = RoiRect {
            x: 100.0 / 480.0,
            y: 65.0 / 270.0,
            w: 270.0 / 480.0,
            h: 165.0 / 270.0,
        };
        assert_camera_truth(&tighten_camera_box(&frames, &rough), truth, 2);
    }

    #[test]
    fn a_supported_top_side_beats_extra_unverified_rough_box_area() {
        let truth = [0, 95, 160, 185];
        let frames: Vec<_> = (0..6).map(|s| weak_frame(s, truth, false)).collect();
        let rough = RoiRect {
            x: 0.0,
            y: 50.0 / 270.0,
            w: 220.0 / 480.0,
            h: 180.0 / 270.0,
        };
        let result = tighten_camera_box(&frames, &rough);
        let actual = [
            result.roi.x * 480.0,
            result.roi.y * 270.0,
            (result.roi.x + result.roi.w) * 480.0,
            (result.roi.y + result.roi.h) * 270.0,
        ]
        .map(|p| p.round() as usize);
        assert_eq!(actual, truth);
        assert_eq!(result.found, [false, true, true, true]);
    }

    #[test]
    fn rectangular_camera_does_not_require_a_fixed_webcam_aspect() {
        let truth = [110, 75, 260, 175]; // 3:2, a common cropped camera picture.
        let frames: Vec<_> = (0..6).map(|s| weak_frame(s, truth, false)).collect();
        let rough = RoiRect {
            x: 70.0 / 480.0,
            y: 45.0 / 270.0,
            w: 230.0 / 480.0,
            h: 165.0 / 270.0,
        };
        assert_camera_truth(&tighten_camera_box(&frames, &rough), truth, 2);
    }

    fn assert_camera_truth(result: &CameraTighten, truth: [usize; 4], tolerance: i64) {
        let actual = [
            result.roi.x * 480.0,
            result.roi.y * 270.0,
            (result.roi.x + result.roi.w) * 480.0,
            (result.roi.y + result.roi.h) * 270.0,
        ]
        .map(|p| p.round() as i64);
        let errors: Vec<_> = actual
            .iter()
            .zip(truth)
            .map(|(a, b)| (a - b as i64).abs())
            .collect();
        assert!(
            errors.iter().all(|&error| error <= tolerance),
            "actual={actual:?}, truth={truth:?}, errors={errors:?}, found={:?}",
            result.found
        );
        assert_eq!(result.found, [true; 4]);
    }
}
