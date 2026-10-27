//! P4a discovery and learning. All inputs are caller-owned grayscale frames.
//! No location prior or font-specific digit labels are used.
use crate::*;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, VecDeque};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TimedFrame {
    pub time: f64,
    pub image: Image,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TickMoment {
    pub last_unchanged: f64,
    pub first_changed: f64,
    pub tick_time: f64,
    pub change: f64,
    pub noise_floor: f64,
}

#[derive(Default)]
pub struct TickMomentDetector {
    previous: Option<Image>,
    previous_time: Option<f64>,
    last_event: Option<f64>,
    noise_floor: f64,
    high: bool,
}

impl TickMomentDetector {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn reset(&mut self) {
        *self = Self::default();
    }
    /// Returns the bracket of the first changed frame. Midpoint is an estimate,
    /// never a claim that time inside an exposure was directly observed.
    pub fn push(&mut self, image: &Image, time: f64) -> Option<TickMoment> {
        if !valid_image(image) || !time.is_finite() {
            self.reset();
            return None;
        }
        let mut result = None;
        if let (Some(previous), Some(last_time)) = (&self.previous, self.previous_time) {
            if previous.width != image.width || previous.height != image.height || time <= last_time
            {
                self.reset();
            } else {
                let changed = previous
                    .data
                    .iter()
                    .zip(&image.data)
                    .filter(|(a, b)| a.abs_diff(**b) >= 24 && (**a >= 145 || **b >= 145))
                    .count() as f64
                    / image.data.len() as f64;
                let threshold = (self.noise_floor * 5.0 + 0.008).max(0.008);
                if changed < threshold * 0.45 {
                    self.high = false;
                }
                let refractory = self.last_event.map(|t| time - t < 0.30).unwrap_or(false);
                if changed >= threshold && !self.high && !refractory {
                    result = Some(TickMoment {
                        last_unchanged: last_time,
                        first_changed: time,
                        tick_time: (last_time + time) * 0.5,
                        change: changed,
                        noise_floor: self.noise_floor,
                    });
                    self.last_event = Some(time);
                    self.high = true;
                } else if changed < threshold && !self.high {
                    self.noise_floor = self.noise_floor * 0.94 + changed * 0.06;
                }
            }
        }
        self.previous = Some(image.clone());
        self.previous_time = Some(time);
        result
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoiCandidate {
    pub roi: RoiRect,
    pub score: f64,
    pub event_times: Vec<f64>,
    pub period: f64,
    pub jitter: f64,
    pub persistence: f64,
    pub glyph_score: f64,
}

fn valid_image(image: &Image) -> bool {
    image.width > 0
        && image.height > 0
        && image.width.checked_mul(image.height) == Some(image.data.len())
}
fn median(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f64::total_cmp);
    let n = values.len();
    (values[n / 2] + values[(n - 1) / 2]) * 0.5
}
fn binary(image: &Image, threshold: f64) -> Image {
    binarize(
        image,
        &PreprocessSettings {
            scale: 1.0,
            threshold,
            invert: false,
        },
    )
}

#[derive(Clone, Copy, Debug)]
struct InkBox {
    x: usize,
    y: usize,
    w: usize,
    h: usize,
    ink: usize,
    parts: usize,
}

fn components(image: &Image, threshold: u8) -> Vec<InkBox> {
    let mut seen = vec![false; image.data.len()];
    let mut out = Vec::new();
    let mut queue = VecDeque::new();
    for start in 0..image.data.len() {
        if seen[start] || image.data[start] < threshold {
            continue;
        }
        seen[start] = true;
        queue.push_back(start);
        let (mut left, mut right, mut top, mut bottom, mut ink) = (
            start % image.width,
            start % image.width,
            start / image.width,
            start / image.width,
            0,
        );
        while let Some(p) = queue.pop_front() {
            let (x, y) = (p % image.width, p / image.width);
            left = left.min(x);
            right = right.max(x);
            top = top.min(y);
            bottom = bottom.max(y);
            ink += 1;
            for (nx, ny) in [
                (x.wrapping_sub(1), y),
                (x + 1, y),
                (x, y.wrapping_sub(1)),
                (x, y + 1),
                (x.wrapping_sub(1), y.wrapping_sub(1)),
                (x + 1, y.wrapping_sub(1)),
                (x.wrapping_sub(1), y + 1),
                (x + 1, y + 1),
            ] {
                if nx >= image.width || ny >= image.height {
                    continue;
                }
                let q = ny * image.width + nx;
                if !seen[q] && image.data[q] >= threshold {
                    seen[q] = true;
                    queue.push_back(q);
                }
            }
        }
        let (w, h) = (right - left + 1, bottom - top + 1);
        if ink >= 1 && h <= image.height.max(100) / 10 && w <= image.width.max(100) / 10 {
            out.push(InkBox {
                x: left,
                y: top,
                w,
                h,
                ink,
                parts: 1,
            });
        }
    }
    out
}

/// Proposals come from horizontal glyph geometry everywhere in the frame.
/// Vertical colon dots are merged before forming complete clock groups.
fn proposals(image: &Image, threshold: u8) -> Vec<Rect> {
    let min_h = (image.height / 250).max(4);
    let max_h = (image.height / 12).max(12);
    let mut boxes = components(image, threshold);
    boxes.sort_by_key(|b| (b.x, b.y));
    let mut merged: Vec<InkBox> = Vec::new();
    for b in boxes {
        let other = merged.iter_mut().rev().take(30).find(|a| {
            a.parts == 1
                && b.parts == 1
                && a.x.abs_diff(b.x) <= 2
                && a.w.abs_diff(b.w) <= 3
                && a.h <= b.h * 2
                && b.h <= a.h * 2
                && b.y >= a.y + a.h
                && b.y - a.y - a.h <= a.h.max(b.h) * 3
                && b.y + b.h - a.y <= max_h
        });
        if let Some(a) = other {
            a.h = b.y + b.h - a.y;
            a.w = a.w.max(b.w);
            a.ink += b.ink;
            a.parts += b.parts;
        } else {
            merged.push(b);
        }
    }
    let boxes: Vec<_> = merged
        .into_iter()
        .filter(|b| b.h >= min_h && b.h <= max_h && b.w <= b.h * 2 && b.ink * 15 >= b.w * b.h)
        .collect();
    let mut result = Vec::new();
    for anchor in &boxes {
        if anchor.w > anchor.h || anchor.h < min_h {
            continue;
        }
        let cy = anchor.y as f64 + anchor.h as f64 * 0.5;
        let mut row: Vec<_> = boxes
            .iter()
            .filter(|b| {
                let other_cy = b.y as f64 + b.h as f64 * 0.5;
                (cy - other_cy).abs() < anchor.h as f64 * 0.30
                    && b.h * 10 >= anchor.h * 4
                    && b.h * 10 <= anchor.h * 14
            })
            .collect();
        row.sort_by_key(|b| b.x);
        for count in [5, 4, 2] {
            for (start, group) in row.windows(count).enumerate() {
                if group.iter().any(|b| b.x == group[0].x && b.y != group[0].y) {
                    continue;
                }
                let shape: Vec<_> = group
                    .iter()
                    .map(|b| GlyphBox {
                        x: b.x as f64,
                        y: b.y as f64,
                        width: b.w as f64,
                        height: b.h as f64,
                        ink: b.ink as f64,
                    })
                    .collect();
                if !clock_shape(&shape) {
                    continue;
                }
                let h = group.iter().map(|b| b.h).max().unwrap();
                // Do not propose a suffix of a longer clock (10:00 -> 0:00 or ss).
                if start > 0
                    && (count == 2 || row[start - 1].h * 10 >= h * 7)
                    && row[start - 1].x + row[start - 1].w <= group[0].x
                    && group[0].x - row[start - 1].x - row[start - 1].w <= h
                    || start + count < row.len()
                        && (count == 2 || row[start + count].h * 10 >= h * 7)
                        && row[start + count].x >= group[count - 1].x + group[count - 1].w
                        && row[start + count].x - group[count - 1].x - group[count - 1].w <= h
                {
                    continue;
                }
                if group
                    .windows(2)
                    .any(|p| p[1].x < p[0].x + p[0].w || p[1].x - p[0].x - p[0].w > h * 3 / 2)
                {
                    continue;
                }
                let x = group[0].x;
                let y = group.iter().map(|b| b.y).min().unwrap();
                let right = group[count - 1].x + group[count - 1].w;
                let bottom = group.iter().map(|b| b.y + b.h).max().unwrap();
                if right - x < h || right - x > h * 7 {
                    continue;
                }
                let margin = (h / 9).max(1);
                let left = x.saturating_sub(margin);
                let top = y.saturating_sub(margin);
                let rect = Rect {
                    x: left as f64,
                    y: top as f64,
                    width: (right + margin).min(image.width).saturating_sub(left) as f64,
                    height: (bottom + margin).min(image.height).saturating_sub(top) as f64,
                };
                if !result.iter().any(|r: &Rect| {
                    (r.x - rect.x).abs() < 3.0
                        && (r.y - rect.y).abs() < 3.0
                        && (r.width - rect.width).abs() < 4.0
                        && (r.height - rect.height).abs() < 4.0
                }) {
                    result.push(rect);
                }
            }
        }
    }
    result
}

fn glyphs(image: &Image, threshold: f64) -> Option<Vec<Image>> {
    let b = binary(image, threshold);
    let boxes = segment_glyphs(&b, &json!({"minGlyphWidth":1,"minInkRatio":0.025})).boxes;
    if !clock_shape(&boxes) {
        return None;
    }
    Some(
        boxes
            .iter()
            .map(|b| crop_binary(&binary(image, threshold), &b.rect()))
            .collect(),
    )
}

fn clock_shape(boxes: &[GlyphBox]) -> bool {
    let count = boxes.len();
    if !matches!(count, 2 | 4 | 5) {
        return false;
    }
    let colon = if count == 2 { None } else { Some(count - 3) };
    let h = boxes
        .iter()
        .enumerate()
        .filter(|(i, _)| Some(*i) != colon)
        .map(|(_, b)| b.height)
        .fold(0.0, f64::max);
    h >= 4.0
        // A team score beside m:ss must not become an extra minutes digit.
        && (count != 5 || boxes[1].x + boxes[1].width * 0.5 - boxes[0].x - boxes[0].width * 0.5 <= h * 1.5)
        && !boxes
            .iter()
            .enumerate()
            .any(|(i, b)| Some(i) != colon && (b.height < h * 0.68 || b.width > h * 1.25))
        && colon
            .map(|i| {
                boxes[i].height >= h * 0.30
                    && !(boxes[i].height > h * 0.92 && boxes[i].width > h * 0.35)
            })
            .unwrap_or(true)
        && !boxes
            .windows(2)
            .any(|p| p[1].x < p[0].x + p[0].width || p[1].x - p[0].x - p[0].width > h * 1.5)
        && even_spacing(boxes, h)
}

/// A clock is set as one tight string of glyphs. A team score beside it can sit within
/// the absolute gap limit, so `3  1:27` would otherwise pass as the `mm:ss` clock `31:27`.
/// Every gap must stay within a small multiple of the tightest gap in the group.
fn even_spacing(boxes: &[GlyphBox], h: f64) -> bool {
    let gaps: Vec<f64> = boxes
        .windows(2)
        .map(|p| p[1].x - p[0].x - p[0].width)
        .collect();
    let tightest = gaps.iter().copied().fold(f64::INFINITY, f64::min);
    gaps.iter().all(|&gap| gap <= tightest * 3.0 + h * 0.25)
}

/// Connected components can under-bound a thin diagonal digit. Re-segment a
/// padded horizontal strip across time and retain the complete glyph envelope,
/// rather than discarding a wider observation as a duplicate of a narrow one.
fn clock_envelope(seed: &Rect, frames: &[TimedFrame]) -> Rect {
    let first = &frames[0].image;
    let left = (seed.x - seed.height).max(0.0);
    let right = (seed.x + seed.width + seed.height).min(first.width as f64);
    let strip = Rect {
        x: left,
        y: seed.y,
        width: right - left,
        height: seed.height,
    };
    let mut envelope = seed.clone();
    let count = frames
        .iter()
        .find_map(|f| glyphs(&crop_binary(&f.image, seed), 190.0).map(|gs| gs.len()))
        .unwrap_or(4);
    for f in frames.iter().step_by((frames.len() / 24).max(1)) {
        let region = binary(&crop_binary(&f.image, &strip), 190.0);
        let boxes = segment_glyphs(&region, &json!({"minGlyphWidth":1,"minInkRatio":0.025})).boxes;
        for group in boxes.windows(count) {
            if !clock_shape(group) {
                continue;
            }
            let x = left + group[0].x;
            let end = left + group[count - 1].x + group[count - 1].width;
            let overlap = (end.min(seed.x + seed.width) - x.max(seed.x)).max(0.0);
            if overlap < seed.width * 0.75
                || end - x > seed.width * 1.5
                || (x - seed.x).abs() > seed.height * 0.35
                || group
                    .windows(2)
                    .any(|p| p[1].x - p[0].x - p[0].width > seed.height)
            {
                continue;
            }
            let margin = (seed.height / 9.0).floor().max(1.0);
            let x = (x - margin).max(0.0);
            let end = (end + margin).min(first.width as f64);
            let union_left = envelope.x.min(x);
            envelope.width = (envelope.x + envelope.width).max(end) - union_left;
            envelope.x = union_left;
        }
    }
    envelope
}

/// Rank only candidates with stable glyphs and ticks distributed through the
/// entire window. A disappearing replay fails the temporal coverage gate.
pub fn locate_clock(frames: &[TimedFrame]) -> Vec<RoiCandidate> {
    if frames.len() < 4
        || frames
            .iter()
            .any(|f| !f.time.is_finite() || !valid_image(&f.image))
    {
        return vec![];
    }
    let first = &frames[0].image;
    if frames
        .iter()
        .any(|f| f.image.width != first.width || f.image.height != first.height)
    {
        return vec![];
    }
    let duration = frames.last().unwrap().time - frames[0].time;
    if duration < 2.5 || frames.windows(2).any(|p| p[1].time <= p[0].time) {
        return vec![];
    }
    let mut rects: Vec<Rect> = vec![];
    for i in [0, frames.len() / 3, frames.len() * 2 / 3, frames.len() - 1] {
        for threshold in [160, 190, 215] {
            for rect in proposals(&frames[i].image, threshold) {
                if !rects.iter().any(|r| {
                    (r.x - rect.x).abs() < 3.0
                        && (r.y - rect.y).abs() < 3.0
                        && (r.width - rect.width).abs() < 5.0
                }) {
                    rects.push(rect);
                }
            }
        }
    }
    let mut result = vec![];
    for seed in rects {
        let rect = clock_envelope(&seed, frames);
        let mut detector = TickMomentDetector::new();
        let mut event_times = vec![];
        let mut good_glyphs = 0;
        for f in frames {
            let roi = crop_binary(&f.image, &rect);
            if [190.0, 160.0, 215.0].iter().any(|&threshold| {
                glyphs(&roi, threshold).is_some()
                    && bounding_box(&binary(&roi, threshold))
                        .is_some_and(|b| b.x >= 1.0 && b.x + b.width < roi.width as f64)
            }) {
                good_glyphs += 1;
            }
            if let Some(tick) = detector.push(&roi, f.time) {
                event_times.push(tick.tick_time);
            }
        }
        let persistence = good_glyphs as f64 / frames.len() as f64;
        if event_times.len() < 3 || persistence < 0.60 {
            continue;
        }
        let intervals: Vec<_> = event_times.windows(2).map(|p| p[1] - p[0]).collect();
        let period = median(intervals.clone());
        let jitter = median(intervals.iter().map(|v| (v - period).abs()).collect());
        let regular = intervals
            .iter()
            .filter(|&&v| (v - 1.0).abs() <= 0.20)
            .count() as f64
            / intervals.len() as f64;
        let span = (event_times.last().unwrap() - event_times[0]) / duration;
        let edge_gap = (event_times[0] - frames[0].time)
            .max(frames.last().unwrap().time - event_times.last().unwrap());
        if (period - 1.0).abs() > 0.18
            || jitter > 0.16
            || regular < 0.75
            || span < 0.45
            || edge_gap > (duration * 0.40).max(2.0)
        {
            continue;
        }
        let glyph_score = persistence;
        let score = (0.40 * regular
            + 0.25 * span.min(1.0)
            + 0.25 * persistence
            + 0.10 * (1.0 - jitter / 0.20).max(0.0))
        .clamp(0.0, 1.0);
        result.push(RoiCandidate {
            roi: RoiRect {
                x: rect.x / first.width as f64,
                y: rect.y / first.height as f64,
                w: rect.width / first.width as f64,
                h: rect.height / first.height as f64,
            },
            score,
            event_times,
            period,
            jitter,
            persistence,
            glyph_score,
        });
    }
    result.sort_by(|a, b| b.score.total_cmp(&a.score));
    // The seconds field of `0:28` ticks exactly like the whole clock, so a bare `28`
    // candidate scores the same as `0:28`. Keeping the narrower one drops the minutes
    // digit and turns every reading into a value modulo 60, which shifts offsets by
    // whole minutes. When one candidate lies inside another on the same row, keep the
    // enclosing one if it is nearly as good.
    let encloses = |outer: &RoiRect, inner: &RoiRect| {
        let tolerance = inner.h * 0.5;
        outer.w > inner.w * 1.15
            && outer.x <= inner.x + tolerance
            && outer.x + outer.w + tolerance >= inner.x + inner.w
            && (outer.y + outer.h * 0.5 - (inner.y + inner.h * 0.5)).abs() <= inner.h * 0.35
    };
    let snapshot = result.clone();
    result.retain(|candidate| {
        !snapshot.iter().any(|other| {
            encloses(&other.roi, &candidate.roi) && other.score >= candidate.score - 0.10
        })
    });
    let mut deduped: Vec<RoiCandidate> = vec![];
    for candidate in result {
        if !deduped.iter().any(|other| {
            let a = &candidate.roi;
            let b = &other.roi;
            let intersection = ((a.x + a.w).min(b.x + b.w) - a.x.max(b.x)).max(0.0)
                * ((a.y + a.h).min(b.y + b.h) - a.y.max(b.y)).max(0.0);
            intersection / (a.w * a.h).min(b.w * b.h) > 0.7
        }) {
            deduped.push(candidate);
        }
        if deduped.len() == 20 {
            break;
        }
    }
    deduped
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnReport {
    pub profile: Option<RecognitionProfile>,
    pub confidence: f64,
    pub learned_chars: Vec<String>,
    pub missing_chars: Vec<String>,
    pub reason: Option<String>,
    pub observations: usize,
    pub consistent_offsets: usize,
}

#[derive(Clone)]
struct Observation {
    time: f64,
    masks: Vec<Vec<u8>>,
    clusters: Vec<usize>,
}

fn failed_learning(reason: &str, observations: usize) -> LearnReport {
    LearnReport {
        profile: None,
        confidence: 0.0,
        learned_chars: vec![],
        missing_chars: CLOCK_CHARS.iter().map(|s| s.to_string()).collect(),
        reason: Some(reason.into()),
        observations,
        consistent_offsets: 0,
    }
}

/// Cluster masks globally, then enumerate starting clock values. The mapping is
/// bijective and must explain every position under strict n -> n-1 decrements.
/// Only assignments common to every consistent solution receive labels.
pub fn learn_clock(frames: &[TimedFrame], roi: &RoiRect) -> LearnReport {
    if frames.len() < 4 {
        return failed_learning("insufficient-frames", 0);
    }
    if frames
        .iter()
        .any(|f| !valid_image(&f.image) || !f.time.is_finite())
        || frames.windows(2).any(|p| p[1].time <= p[0].time)
    {
        return failed_learning("invalid-frames", 0);
    }
    let mut best = None;
    for threshold in [190.0, 160.0, 210.0, 130.0] {
        let report = learn_at_threshold(frames, roi, threshold);
        if best
            .as_ref()
            .map(|b: &LearnReport| {
                let solved = report.profile.is_some() && report.reason.is_none();
                let best_solved = b.profile.is_some() && b.reason.is_none();
                solved && !best_solved
                    || solved == best_solved
                        && (report.confidence > b.confidence
                            || report.confidence == b.confidence
                                && report.observations > b.observations)
            })
            .unwrap_or(true)
        {
            best = Some(report);
        }
    }
    best.unwrap_or_else(|| failed_learning("no-glyph-sequence", 0))
}

fn learn_at_threshold(frames: &[TimedFrame], roi: &RoiRect, threshold: f64) -> LearnReport {
    let mut detector = TickMomentDetector::new();
    let mut runs: Vec<Vec<Observation>> = vec![vec![]];
    let mut last_accept = f64::NEG_INFINITY;
    for f in frames {
        let region = crop_binary(&f.image, &roi_to_pixels(roi, f.image.width, f.image.height));
        let event = detector.push(&region, f.time);
        if event.is_none() && !runs.last().unwrap().is_empty() {
            continue;
        }
        let Some(gs) = glyphs(&region, threshold) else {
            continue;
        };
        let masks: Vec<_> = gs.iter().map(normalize_glyph).collect();
        if let Some(last) = runs.last().unwrap().last() {
            let similarity = score_masks(last.masks.last().unwrap(), masks.last().unwrap());
            if similarity > 0.94 {
                continue;
            }
            let elapsed = f.time - last_accept;
            if !(0.72..=1.28).contains(&elapsed) || last.masks.len() != masks.len() {
                runs.push(vec![]);
            }
        }
        last_accept = f.time;
        runs.last_mut().unwrap().push(Observation {
            time: f.time,
            masks,
            clusters: vec![],
        });
    }
    runs.sort_by_key(|r| std::cmp::Reverse(r.len()));
    let Some(mut observations) = runs.into_iter().next() else {
        return failed_learning("no-glyph-sequence", 0);
    };
    if observations.len() < 5 {
        return failed_learning("insufficient-decrements", observations.len());
    }
    let mut centers: Vec<Vec<u8>> = vec![];
    for observation in &mut observations {
        for mask in &observation.masks {
            let found = centers
                .iter()
                .enumerate()
                .map(|(i, m)| (i, score_masks(mask, m)))
                .max_by(|a, b| a.1.total_cmp(&b.1));
            let index = if let Some((i, score)) = found.filter(|(_, score)| *score >= 0.92) {
                let _ = score;
                i
            } else {
                centers.push(mask.clone());
                centers.len() - 1
            };
            observation.clusters.push(index);
        }
    }
    let mut solutions: Vec<Vec<Option<char>>> = vec![];
    let positions = observations[0].masks.len();
    for start in (observations.len() - 1)..clock_limit(positions) {
        let mut labels = vec![None; centers.len()];
        let mut reverse = BTreeMap::<char, usize>::new();
        let mut good = true;
        for (i, o) in observations.iter().enumerate() {
            let n = start - i;
            let Some(expected) = clock_labels(n, positions) else {
                good = false;
                break;
            };
            for (&cluster, &label) in o.clusters.iter().zip(&expected) {
                if labels[cluster]
                    .map(|existing| existing != label)
                    .unwrap_or(false)
                    || reverse
                        .get(&label)
                        .map(|&existing| existing != cluster)
                        .unwrap_or(false)
                {
                    good = false;
                    break;
                }
                labels[cluster] = Some(label);
                reverse.insert(label, cluster);
            }
            if !good {
                break;
            }
        }
        if good {
            solutions.push(labels);
        }
    }
    // Compression may split one digit into several tight clusters. If exact
    // cluster equalities cannot solve the sequence, compare all mask pairs and
    // retain every numerical offset with indistinguishable consistency cost.
    // This uses shape equality, never a pre-labelled font or a selected offset.
    let (certain, solution_count, quality) = if solutions.is_empty() {
        let Some((labels, count, quality)) = soft_assignments(&observations) else {
            return failed_learning("no-consistent-countdown", observations.len());
        };
        (labels, count, quality)
    } else {
        let mut labels = solutions[0].clone();
        for solution in &solutions[1..] {
            for (label, other) in labels.iter_mut().zip(solution) {
                if label != other {
                    *label = None;
                }
            }
        }
        let by_observation = observations
            .iter()
            .flat_map(|o| o.clusters.iter().map(|&cluster| labels[cluster]))
            .collect();
        (by_observation, solutions.len(), 1.0)
    };
    let mut templates = BTreeMap::<String, Vec<TemplateSample>>::new();
    for (i, o) in observations.iter().enumerate() {
        for (p, mask) in o.masks.iter().enumerate() {
            let Some(label) = certain[i * positions + p] else {
                continue;
            };
            let samples = templates.entry(label.to_string()).or_default();
            if samples.len() < 4 && (samples.is_empty() || i % 3 == 0) {
                samples.push(TemplateSample {
                    id: format!("auto-{label}-{i}-{p}"),
                    data: pack_bitmap(mask),
                    created_at: o.time,
                    origin: Some("countdown-self-learning".into()),
                });
            }
        }
    }
    let learned_chars: Vec<_> = CLOCK_CHARS
        .iter()
        .filter(|c| templates.contains_key(**c))
        .map(|s| s.to_string())
        .collect();
    let missing_chars = CLOCK_CHARS
        .iter()
        .filter(|c| !templates.contains_key(**c))
        .map(|s| s.to_string())
        .collect();
    let ambiguous = solution_count > 1;
    let confidence = if ambiguous {
        learned_chars.len() as f64 / 11.0 * 0.5
    } else {
        (0.85 + observations.len().min(30) as f64 / 200.0).min(1.0) * quality
    };
    let profile = if templates.len() > 1 {
        Some(RecognitionProfile {
            schema_version: 2,
            id: "auto/countdown".into(),
            name: "自动学习候选".into(),
            roi: roi.clone(),
            clock_format: if positions == 2 {
                "ss"
            } else if positions == 5 {
                "mm:ss"
            } else {
                "m:ss"
            }
            .into(),
            detect_window_seconds: 3.0,
            sample_fps: 30.0,
            // Keep the generated profile aligned with the desktop sync confidence floor.
            match_threshold: 0.82,
            preprocess: PreprocessSettings {
                scale: 1.0,
                threshold,
                invert: false,
            },
            templates,
            updated_at: 0.0,
            notes: Some("仅包含由倒计时一致性唯一确定的字符, 未观察到的字符保持缺失.".into()),
        })
    } else {
        None
    };
    LearnReport {
        profile,
        confidence,
        learned_chars,
        missing_chars,
        reason: if ambiguous {
            Some("ambiguous-countdown-labels".into())
        } else {
            None
        },
        observations: observations.len(),
        consistent_offsets: solution_count,
    }
}

fn expected_labels(n: usize) -> [char; 4] {
    [
        char::from_digit((n / 60) as u32, 10).unwrap(),
        ':',
        char::from_digit((n % 60 / 10) as u32, 10).unwrap(),
        char::from_digit((n % 10) as u32, 10).unwrap(),
    ]
}

fn clock_limit(positions: usize) -> usize {
    match positions {
        2 => 60,
        5 => 6000,
        _ => 600,
    }
}

fn clock_labels(n: usize, positions: usize) -> Option<Vec<char>> {
    match positions {
        2 if n < 60 => Some(format!("{n:02}").chars().collect()),
        4 if n < 600 => Some(expected_labels(n).to_vec()),
        // Two displayed minute digits can include a leading zero.
        5 if n < 6000 => Some(format!("{:02}:{:02}", n / 60, n % 60).chars().collect()),
        _ => None,
    }
}

fn soft_assignments(observations: &[Observation]) -> Option<(Vec<Option<char>>, usize, f64)> {
    if observations.len() < 10 {
        return None;
    }
    let masks: Vec<_> = observations.iter().flat_map(|o| o.masks.iter()).collect();
    let positions = observations[0].masks.len();
    let size = masks.len();
    let mut similarity = vec![0.0; size * size];
    for i in 0..size {
        for j in 0..i {
            let score = score_masks(masks[i], masks[j]);
            similarity[i * size + j] = score;
            similarity[j * size + i] = score;
        }
    }
    let mut candidates = vec![];
    for start in (observations.len() - 1)..clock_limit(positions) {
        let labels: Vec<_> = (0..observations.len())
            .flat_map(|i| clock_labels(start - i, positions).unwrap())
            .collect();
        // Weight each (digit, position pair) equally. Otherwise a constant
        // minute shown in 30 frames overwhelms a wrong match to one seconds
        // glyph, yielding a numerically valid but falsely labelled profile.
        let buckets = 10 * positions * positions;
        let mut sums = vec![0.0; buckets];
        let mut counts = vec![0; buckets];
        for i in 0..size {
            if labels[i] == ':' {
                continue;
            }
            let digit = labels[i].to_digit(10).unwrap() as usize;
            for j in 0..i {
                if labels[i] == labels[j] {
                    let position_i = i % positions;
                    let position_j = j % positions;
                    let bucket = digit * positions * positions
                        + position_i.min(position_j) * positions
                        + position_i.max(position_j);
                    sums[bucket] += similarity[i * size + j];
                    counts[bucket] += 1;
                }
            }
        }
        let quality: Vec<_> = (0..buckets)
            .filter(|&d| counts[d] > 0)
            .map(|d| sums[d] / counts[d] as f64)
            .collect();
        if quality.is_empty() || quality.iter().any(|&q| q < 0.60) {
            continue;
        }
        let score = quality.iter().sum::<f64>() / quality.len() as f64;
        if score >= 0.85 {
            candidates.push((labels, score));
        }
    }
    let best = candidates.iter().map(|(_, s)| *s).fold(0.0, f64::max);
    let retained: Vec<_> = candidates
        .into_iter()
        .filter(|(_, s)| *s >= best - 0.004)
        .collect();
    let (first, _) = retained.first()?;
    let mut labels: Vec<_> = first.iter().copied().map(Some).collect();
    for (candidate, _) in &retained[1..] {
        for (label, &other) in labels.iter_mut().zip(candidate) {
            if *label != Some(other) {
                *label = None;
            }
        }
    }
    Some((labels, retained.len(), best))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoReading {
    pub text: Option<String>,
    pub value: Option<f64>,
    pub confidence: f64,
    pub reason: Option<String>,
}

/// P4a permits an explicitly partial learned profile, but never fills a missing
/// character. P3 recognize_frame and its readiness/parity contract are unchanged.
pub fn recognize_auto_frame(image: &Image, profile: &RecognitionProfile) -> AutoReading {
    let fail = |reason: &str, confidence: f64| AutoReading {
        text: None,
        value: None,
        confidence,
        reason: Some(reason.into()),
    };
    if !valid_image(image) {
        return fail("invalid-frame", 0.0);
    }
    let region = crop_binary(
        image,
        &roi_to_pixels(&profile.roi, image.width, image.height),
    );
    let Some(gs) = glyphs(&region, profile.preprocess.threshold) else {
        return fail("no-clock-glyphs", 0.0);
    };
    let templates = compile_templates(profile);
    let mut text = String::new();
    let mut confidence = 1.0_f64;
    for glyph in gs {
        let m = match_glyph(&normalize_glyph(&glyph), &templates);
        confidence = confidence.min(m.score);
        if m.score < profile.match_threshold || m.score - m.runner_up_score < 0.035 {
            return fail("low-confidence", confidence);
        }
        let Some(c) = m.char else {
            return fail("missing-template", 0.0);
        };
        text.push_str(&c);
    }
    // Display length may change at a minute boundary or near round end.
    let Some(value) = parse_countdown(&text, "auto") else {
        return fail("invalid-format", confidence);
    };
    AutoReading {
        text: Some(text),
        value: Some(value),
        confidence,
        reason: None,
    }
}

#[cfg(test)]
#[path = "auto_tests.rs"]
mod tests;
