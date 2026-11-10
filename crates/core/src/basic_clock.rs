//! Conservative, session-only countdown discovery from supplied numeric glyph priors.
use crate::{
    bounding_box, crop_binary, normalize_glyph, parse_countdown, segment_glyphs, unpack_bitmap,
    GlyphBox, Image, Rect, RoiRect, TickMoment, TickMomentDetector, CLOCK_CHARS,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const MIN_SCORE: f64 = 0.82;
const MIN_MARGIN: f64 = 0.035;
// Standard CS2 round clocks never exceed 1:55; adjacent score digits must not become minutes.
const MAX_FORMAL_SECONDS: f64 = 115.0;
const SEARCH_INTERVAL: f64 = 0.25;
const LOCKED_SEARCH_INTERVAL: f64 = 0.75;
const MAX_CANDIDATES: usize = 32;

#[derive(Clone, PartialEq, Eq)]
struct PackedMask {
    words: [u64; 24],
    ink: u32,
    boundary: [u64; 24],
    holes: u8,
    hole_y: [u8; 4],
}
impl PackedMask {
    fn new(mask: &[u8]) -> Self {
        let mut result = Self {
            words: [0; 24],
            ink: 0,
            boundary: [0; 24],
            holes: 0,
            hole_y: [0; 4],
        };
        for (index, pixel) in mask.iter().take(1536).enumerate() {
            if *pixel != 0 {
                result.words[index / 64] |= 1u64 << (index % 64);
                result.ink += 1;
            }
        }
        result.boundary = neighbour_words(&result.words);
        (result.holes, result.hole_y) = enclosed_topology(&result.words);
        result
    }
    fn score(&self, sample: &Self) -> f64 {
        let intersection: u32 = self
            .words
            .iter()
            .zip(&sample.words)
            .map(|(left, right)| (left & right).count_ones())
            .sum();
        let union = self.ink + sample.ink - intersection;
        if union == 0 {
            0.0
        } else {
            intersection as f64 / union as f64
        }
    }
    /// This fallback is a boundary similarity, not an exact pixel IoU. Only
    /// mutually supported, one-pixel edge discrepancies receive compensation;
    /// source topology and the structurally valid nominal winner must still agree.
    fn boundary_score(&self, sample: &Self) -> f64 {
        let (mut intersection, mut query_near, mut sample_near) = (0, 0, 0);
        for index in 0..24 {
            let query = self.words[index];
            let reference = sample.words[index];
            intersection += (query & reference).count_ones();
            query_near += (query & !reference & sample.boundary[index]).count_ones();
            sample_near += (reference & !query & self.boundary[index]).count_ones();
        }
        let compensated = query_near.min(sample_near);
        let union = self.ink + sample.ink - intersection - compensated;
        if union == 0 {
            0.0
        } else {
            (intersection + compensated) as f64 / union as f64
        }
    }
    fn same_source_topology(&self, evidence: &(u8, [u8; 4])) -> bool {
        self.holes == evidence.0
            && self.holes <= 4
            && (0..self.holes as usize)
                .all(|index| self.hole_y[index].abs_diff(evidence.1[index]) <= 12)
    }

    fn valid_character_topology(&self, symbol: &str) -> bool {
        // Thickening a prior can close an open 3 or 5 into a false 9 or 6.
        // Such altered priors must not override a real digit's enclosed regions.
        match symbol {
            // Slashed zero has two counters; exact shape and counter positions
            // still compete against eight and every other eligible character.
            "0" => (1..=2).contains(&self.holes),
            "6" | "9" => self.holes == 1,
            "8" => self.holes == 2,
            "4" => self.holes <= 1,
            _ => self.holes == 0,
        }
    }
}

fn neighbour_words(words: &[u64; 24]) -> [u64; 24] {
    let mut result = [0; 24];
    for y in 0..48 {
        let row = (words[y / 2] >> ((y % 2) * 32)) as u32;
        let above = if y > 0 {
            (words[(y - 1) / 2] >> (((y - 1) % 2) * 32)) as u32
        } else {
            0
        };
        let below = if y < 47 {
            (words[(y + 1) / 2] >> (((y + 1) % 2) * 32)) as u32
        } else {
            0
        };
        result[y / 2] |= ((row | (row << 1) | (row >> 1) | above | below) as u64) << ((y % 2) * 32);
    }
    result
}
fn glyph_topology(gray: &Image) -> (u8, [u8; 4]) {
    // Read holes before normalization: low-resolution resampling can close an
    // open arc, or erase one hole of an 8. All thresholds describe this same
    // observed glyph; no inferred character or previous reading is involved.
    [135, 180, 215]
        .into_iter()
        .map(|threshold| source_topology(&threshold_gray(gray, threshold)))
        .max_by_key(|evidence| evidence.0)
        .unwrap()
}

fn source_topology(image: &Image) -> (u8, [u8; 4]) {
    let Some(bounds) = bounding_box(image) else {
        return (0, [0; 4]);
    };
    let image = crop_binary(image, &bounds);
    let mut seen = vec![false; image.data.len()];
    let mut queue = Vec::new();
    let mut count = 0;
    let mut centers = [0; 4];
    let minimum = ((image.data.len() as f64) * 0.005).ceil().max(2.0) as usize;
    for start in 0..image.data.len() {
        if seen[start] || image.data[start] != 0 {
            continue;
        }
        queue.clear();
        queue.push(start);
        seen[start] = true;
        let (mut cursor, mut edge) = (0, false);
        while cursor < queue.len() {
            let at = queue[cursor];
            cursor += 1;
            let x = at % image.width;
            let y = at / image.width;
            edge |= x == 0 || x + 1 == image.width || y == 0 || y + 1 == image.height;
            for next in [
                if x > 0 { at - 1 } else { at },
                if x + 1 < image.width { at + 1 } else { at },
                if y > 0 { at - image.width } else { at },
                if y + 1 < image.height {
                    at + image.width
                } else {
                    at
                },
            ] {
                if !seen[next] && image.data[next] == 0 {
                    seen[next] = true;
                    queue.push(next);
                }
            }
        }
        if !edge && queue.len() >= minimum {
            if count < 4 {
                centers[count as usize] =
                    (queue.iter().map(|index| index / image.width).sum::<usize>() as f64
                        / queue.len() as f64
                        * 96.0
                        / image.height as f64)
                        .round() as u8;
            }
            count += 1;
        }
    }
    centers[..(count as usize).min(4)].sort_unstable();
    (count, centers)
}
fn enclosed_topology(words: &[u64; 24]) -> (u8, [u8; 4]) {
    let mut seen = [false; 1536];
    let mut holes = 0;
    let mut centers = [0; 4];
    let mut queue = Vec::with_capacity(1536);
    for start in 0..1536 {
        if seen[start] || words[start / 64] >> (start % 64) & 1 != 0 {
            continue;
        }
        queue.clear();
        queue.push(start);
        seen[start] = true;
        let (mut cursor, mut touches_edge) = (0, false);
        while cursor < queue.len() {
            let at = queue[cursor];
            cursor += 1;
            let x = at % 32;
            let y = at / 32;
            touches_edge |= x == 0 || x == 31 || y == 0 || y == 47;
            for next in [
                if x > 0 { at - 1 } else { at },
                if x < 31 { at + 1 } else { at },
                if y > 0 { at - 32 } else { at },
                if y < 47 { at + 32 } else { at },
            ] {
                if !seen[next] && words[next / 64] >> (next % 64) & 1 == 0 {
                    seen[next] = true;
                    queue.push(next);
                }
            }
        }
        // Ignore tiny rasterization pinholes, while retaining digit counters.
        if !touches_edge && queue.len() >= 12 {
            if holes < 4 {
                centers[holes as usize] = ((queue.iter().map(|index| index / 32).sum::<usize>()
                    as f64
                    / queue.len() as f64)
                    * 2.0)
                    .round() as u8;
            }
            holes += 1;
        }
    }
    centers[..(holes as usize).min(4)].sort_unstable();
    (holes, centers)
}

#[derive(Clone, Debug)]
struct Component {
    x: usize,
    y: usize,
    w: usize,
    h: usize,
    ink: usize,
}
impl Component {
    fn right(&self) -> usize {
        self.x + self.w
    }
    fn bottom(&self) -> usize {
        self.y + self.h
    }
    fn cx(&self) -> f64 {
        self.x as f64 + self.w as f64 / 2.0
    }
    fn cy(&self) -> f64 {
        self.y as f64 + self.h as f64 / 2.0
    }
}

#[derive(Clone)]
struct Reading {
    rect: Rect,
    text: String,
    seconds: f64,
    confidence: f64,
    scores: Vec<f64>,
    gray: Image,
    debug: Value,
    threshold: u8,
    glyph_rect: Rect,
}

struct ReadAttempt {
    reading: Option<Reading>,
    debug: Value,
    threshold: Option<u8>,
    reason: &'static str,
}
struct Discovery {
    readings: Vec<Reading>,
    regions: Vec<Rect>,
    failure: Option<ReadAttempt>,
}

struct ClockLayout {
    rect: Rect,
    timing_rect: Rect,
    threshold: u8,
    confirmed: bool,
}

struct ClockTiming {
    value: Option<f64>,
    pending: Option<f64>,
    pending_frames: usize,
    pending_at: f64,
    last_change: Option<f64>,
    decrements: usize,
    last_seen: Option<f64>,
    tick: TickMomentDetector,
    pending_tick: Option<TickMoment>,
    invalidated: bool,
}

struct Track {
    layout: ClockLayout,
    timing: ClockTiming,
}

/// Session layout evidence survives playback interruptions; clock timing never does.
pub struct BasicClockRecognizer {
    templates: Vec<(String, Vec<PackedMask>)>,
    track: Option<Track>,
    last_search: f64,
    last_time: Option<f64>,
    dimensions: (usize, usize),
    ambiguous: bool,
    manual_roi: Option<RoiRect>,
    search_roi: Option<RoiRect>,
    candidates: Vec<Rect>,
}

impl BasicClockRecognizer {
    pub fn new(templates_json: &str) -> Result<Self, String> {
        if templates_json.len() > 1_000_000 {
            return Err("基础字形数据过大".into());
        }
        let encoded: BTreeMap<String, Vec<String>> =
            serde_json::from_str(templates_json).map_err(|_| "基础字形数据格式无效")?;
        if encoded.len() != CLOCK_CHARS.len() {
            return Err("基础字形需要数字 0-9 和冒号".into());
        }
        let mut templates = Vec::new();
        for char in CLOCK_CHARS {
            let samples = encoded.get(char).ok_or("基础字形缺少必要字符")?;
            if samples.is_empty() || samples.len() > 96 {
                return Err("基础字形样本数量无效".into());
            }
            let mut masks = Vec::new();
            for sample in samples {
                if sample.len() != 256 {
                    return Err("基础字形必须为 32x48 位图".into());
                }
                let mask = unpack_bitmap(sample, 1536)?;
                let ink = mask.iter().filter(|&&v| v != 0).count();
                if !(12..1500).contains(&ink) {
                    return Err("基础字形位图为空或过密".into());
                }
                let packed = PackedMask::new(&mask);
                if !masks.contains(&packed) {
                    masks.push(packed);
                }
            }
            templates.push((char.to_owned(), masks));
        }
        Ok(Self {
            templates,
            track: None,
            last_search: f64::NEG_INFINITY,
            last_time: None,
            dimensions: (0, 0),
            ambiguous: false,
            manual_roi: None,
            search_roi: None,
            candidates: Vec::new(),
        })
    }

    /// An explicit null is the only operation that restores automatic discovery.
    pub fn set_roi(&mut self, roi_json: &str) -> Result<(), String> {
        self.manual_roi = parse_region(roi_json)?;
        self.reset();
        Ok(())
    }

    pub fn set_search_roi(&mut self, roi_json: &str) -> Result<(), String> {
        self.search_roi = parse_region(roi_json)?;
        self.reset();
        Ok(())
    }

    /// Promote the exact verified envelope to a fixed memory ROI without relearning it.
    pub fn set_roi_preserving_layout(&mut self, roi_json: &str) -> Result<(), String> {
        let roi = parse_region(roi_json)?.ok_or("记忆区域不能为空")?;
        let (width, height) = self.dimensions;
        let rect = crate::roi_to_pixels(&roi, width, height);
        let compatible = self.track.as_ref().is_some_and(|track| {
            track.layout.confirmed
                && [
                    track.layout.rect.x - rect.x,
                    track.layout.rect.y - rect.y,
                    track.layout.rect.width - rect.width,
                    track.layout.rect.height - rect.height,
                ]
                .into_iter()
                .all(|difference| difference.abs() <= 1.0)
        });
        if !compatible {
            return Err("记忆区域与已验证倒计时区域不一致".into());
        }
        self.manual_roi = Some(roi);
        Ok(())
    }

    pub fn reset(&mut self) {
        self.track = None;
        self.last_search = f64::NEG_INFINITY;
        self.last_time = None;
        self.dimensions = (0, 0);
        self.ambiguous = false;
        self.candidates.clear();
    }

    /// Retain only a layout verified by real decrements, never an unconfirmed candidate.
    pub fn reset_timing(&mut self) {
        if self
            .track
            .as_ref()
            .is_some_and(|track| track.layout.confirmed)
        {
            self.track.as_mut().unwrap().timing = new_timing();
        } else {
            self.track = None;
        }
        self.last_search = f64::NEG_INFINITY;
        self.last_time = None;
        self.ambiguous = false;
        self.candidates.clear();
    }

    pub fn push(
        &mut self,
        rgba: &[u8],
        width: usize,
        height: usize,
        media_time: f64,
        wall_time: f64,
        frame_index: f64,
        want_debug: bool,
    ) -> Value {
        let mut result = self.push_frame(
            rgba,
            width,
            height,
            media_time,
            wall_time,
            frame_index,
            want_debug,
        );
        result["basic"]["mode"] = json!(if self.manual_roi.is_some() {
            "manual"
        } else {
            "auto"
        });
        if let Some(roi) = &self.manual_roi {
            result["basic"]["roi"] = json!(roi);
        }
        if let Some(roi) = &self.search_roi {
            result["basic"]["searchRoi"] = json!(roi);
        }
        if want_debug {
            result["basic"]["candidates"] = json!(self
                .candidates
                .iter()
                .map(|rect| roi_json(rect, width, height))
                .collect::<Vec<_>>());
            if width
                .checked_mul(height)
                .is_some_and(|count| count > 0 && count <= 16_777_216 && rgba.len() >= count * 4)
            {
                result["basic"]["preview"] = json!(scaled_gray(rgba, width, height, 320));
            }
        }
        result
    }

    fn push_frame(
        &mut self,
        rgba: &[u8],
        width: usize,
        height: usize,
        media_time: f64,
        wall_time: f64,
        frame_index: f64,
        want_debug: bool,
    ) -> Value {
        let Some(count) = width
            .checked_mul(height)
            .filter(|&n| n > 0 && n <= 16_777_216)
        else {
            self.reset();
            return failed("searching", "decode-failed", "帧尺寸无效", None);
        };
        if rgba.len() < count * 4
            || !media_time.is_finite()
            || !wall_time.is_finite()
            || !frame_index.is_finite()
        {
            self.reset_timing();
            return failed("searching", "decode-failed", "帧数据或时间戳无效", None);
        }
        if self.dimensions == (width, height) && self.last_time == Some(media_time) {
            // A diagnostic readback can repeat a decoded frame. It neither proves
            // another stable frame nor invalidates earlier real decrements.
            let rect = self
                .manual_roi
                .as_ref()
                .map(|roi| crate::roi_to_pixels(roi, width, height))
                .or_else(|| self.track.as_ref().map(|track| track.layout.rect.clone()));
            let status = if self
                .track
                .as_ref()
                .is_some_and(|track| track.timing.decrements >= 2)
            {
                "locked"
            } else {
                "confirming"
            };
            let mut result = json!({"outcome":{"status":"indeterminate","reason":"basic-clock-duplicate-frame"},
                "debug":null,"basic":{"status":status}});
            if let Some(rect) = rect {
                result["basic"]["roi"] = roi_json(&rect, width, height);
                if want_debug {
                    let mut attempt = self.read_rect_detail(rgba, width, height, &rect, true);
                    if let Some(reading) = attempt.reading.take() {
                        result["debug"] = reading.debug;
                        result["basic"]["text"] = json!(reading.text);
                        result["basic"]["threshold"] = json!(reading.threshold);
                    } else {
                        result = with_attempt(result, Some(attempt));
                    }
                }
            }
            return result;
        }
        if self.dimensions != (width, height) {
            self.reset();
        } else if self
            .last_time
            .is_some_and(|last| media_time < last || media_time - last > 2.5)
        {
            self.reset_timing();
        }
        self.dimensions = (width, height);
        self.last_time = Some(media_time);

        let cached_layout = self
            .track
            .as_ref()
            .is_some_and(|track| track.layout.confirmed);
        // Start at the verified rectangle immediately after an interruption.
        if cached_layout && !self.last_search.is_finite() {
            self.last_search = media_time;
        }
        let search_due = self.manual_roi.is_none()
            && (media_time - self.last_search
                >= if cached_layout {
                    LOCKED_SEARCH_INTERVAL
                } else {
                    SEARCH_INTERVAL
                }
                || (want_debug && self.track.is_none()));
        let mut discovered = None;
        let mut failed_discovery = None;
        if search_due {
            self.last_search = media_time;
            let discovery = self.discover_detail(rgba, width, height, want_debug);
            self.ambiguous = discovery.readings.len() > 1;
            if self.ambiguous {
                self.reset_timing();
                self.candidates = discovery.regions;
                self.last_search = media_time;
                self.ambiguous = true;
                let mut result = failed(
                    "ambiguous",
                    "no-candidates",
                    "发现多个倒计时候选, 无法确定比赛时钟",
                    None,
                );
                if want_debug {
                    if let Some(reading) = discovery.readings.into_iter().next() {
                        result["debug"] = reading.debug;
                        result["basic"]["threshold"] = json!(reading.threshold);
                    }
                }
                return result;
            }
            self.candidates = discovery.regions;
            discovered = discovery.readings.into_iter().next();
            failed_discovery = discovery.failure;
            if let Some(reading) = &discovered {
                let same = self
                    .track
                    .as_ref()
                    .is_some_and(|track| same_region(&track.layout.rect, &reading.rect));
                if !same && !cached_layout {
                    self.track = Some(new_track(reading, media_time));
                }
                if !same && cached_layout {
                    discovered = None;
                }
            }
        }
        if self.ambiguous {
            return failed(
                "ambiguous",
                "no-candidates",
                "发现多个倒计时候选, 无法确定比赛时钟",
                None,
            );
        }

        let manual_rect = self
            .manual_roi
            .as_ref()
            .map(|roi| crate::roi_to_pixels(roi, width, height));
        let Some(rect) =
            manual_rect.or_else(|| self.track.as_ref().map(|track| track.layout.rect.clone()))
        else {
            let reason = failed_discovery
                .as_ref()
                .map(|attempt| attempt.reason)
                .unwrap_or("no-candidates");
            let detail = if failed_discovery.is_some() {
                "已找到候选区域, 尚未通过倒计时校验"
            } else {
                "正在寻找倒计时"
            };
            let result = failed("searching", reason, detail, None);
            return with_attempt(result, failed_discovery);
        };
        let attempt = if discovered.is_none() {
            Some(self.read_rect_detail(rgba, width, height, &rect, want_debug))
        } else {
            None
        };
        let (reading, failure) = match attempt {
            Some(mut attempt) => (attempt.reading.take(), Some(attempt)),
            None => (discovered, None),
        };
        let Some(reading) = reading else {
            let stale = self.track.as_ref().is_some_and(|track| {
                track
                    .timing
                    .last_seen
                    .is_some_and(|last| media_time - last > 0.6)
            });
            if stale {
                self.reset_timing();
            }
            let reason = failure
                .as_ref()
                .map(|attempt| attempt.reason)
                .unwrap_or("low-confidence");
            let result = failed(
                "searching",
                reason,
                "倒计时字形不清晰, 未用于对齐",
                Some(roi_json(&rect, width, height)),
            );
            return with_attempt(result, failure);
        };
        if self.track.is_none() {
            self.track = Some(new_track(&reading, media_time));
        }
        let track = self.track.as_mut().unwrap();
        // The envelope grows only within one matching clock. It cannot follow a new location.
        if self.manual_roi.is_none() {
            track.layout.rect = union_rect(&track.layout.rect, &reading.rect);
        } else {
            track.layout.rect = rect;
        }
        track.layout.threshold = reading.threshold;
        let timing = &mut track.timing;
        timing.last_seen = Some(media_time);
        let tick = if self.manual_roi.is_some() {
            // Keep the user's recognition rectangle exact. Timing alone uses a
            // fixed inner glyph envelope so blank margins cannot dilute motion.
            let local_timing_rect = Rect {
                x: track.layout.timing_rect.x - reading.rect.x,
                y: track.layout.timing_rect.y - reading.rect.y,
                width: track.layout.timing_rect.width,
                height: track.layout.timing_rect.height,
            };
            timing
                .tick
                .push(&crop_binary(&reading.gray, &local_timing_rect), media_time)
        } else {
            timing.tick.push(&reading.gray, media_time)
        };
        if let Some(tick) = tick {
            timing.pending_tick = Some(tick);
        }
        if Some(reading.seconds) != timing.pending {
            timing.pending = Some(reading.seconds);
            timing.pending_frames = 1;
            timing.pending_at = media_time;
        } else {
            timing.pending_frames += 1;
        }
        let mut validated_decrement = false;
        if timing.pending_frames >= 2 && Some(reading.seconds) != timing.value {
            let at = timing.pending_at;
            let interval_ok = timing
                .last_change
                .map(|last| (0.70..=1.30).contains(&(at - last)))
                .unwrap_or(true);
            if timing
                .value
                .is_some_and(|value| value - reading.seconds == 1.0)
                && interval_ok
            {
                timing.decrements += 1;
                timing.last_change = Some(at);
                validated_decrement = true;
            } else {
                // A new baseline after reset contains no contradictory time evidence.
                if timing.value.is_some() {
                    timing.invalidated = true;
                }
                timing.decrements = 0;
                timing.last_change = None;
                timing.pending_tick = None;
                timing.tick.reset();
            }
            timing.value = Some(reading.seconds);
        }
        // A held, paused clock cannot remain an accepted countdown indefinitely.
        if timing
            .last_change
            .or(Some(timing.pending_at))
            .is_some_and(|last| media_time - last > 1.5)
        {
            timing.invalidated = true;
            timing.decrements = 0;
            timing.last_change = None;
            timing.tick.reset();
            timing.pending_tick = None;
        }
        let roi = roi_json(&track.layout.rect, width, height);
        // A verified layout can supply strict OCR immediately after a timing reset.
        // The caller still needs two new jumps before alignment; no old ticks survive.
        if ((!track.layout.confirmed || timing.invalidated) && timing.decrements < 2)
            || timing.pending_frames < 2
            || Some(reading.seconds) != timing.value
        {
            return json!({"outcome":{"status":"indeterminate","reason":"basic-clock-confirming"},
                "debug":if want_debug { reading.debug } else { Value::Null },
                "basic":{"status":"confirming","roi":roi,"text":reading.text,"threshold":reading.threshold}});
        }
        if timing.decrements >= 2 {
            track.layout.confirmed = true;
            timing.invalidated = false;
        }
        let mut result = json!({"outcome":{"status":"success","reading":{
            "text":reading.text,"seconds":reading.seconds,"scores":reading.scores,"confidence":reading.confidence,
            "mediaTime":media_time,"wallTime":wall_time,"frameIndex":frame_index}},
            "debug":if want_debug { reading.debug } else { Value::Null },
            "basic":{"status":"locked","roi":roi,"text":reading.text,"threshold":reading.threshold}});
        if let Some(tick) = timing
            .pending_tick
            .take()
            .filter(|tick| validated_decrement && media_time - tick.first_changed <= 0.5)
        {
            result["tickMoment"] = json!({"lastUnchanged":tick.last_unchanged,"firstChanged":tick.first_changed,
                "midpoint":tick.tick_time,"change":tick.change,"noiseFloor":tick.noise_floor});
        }
        result
    }

    #[cfg(test)]
    fn discover(&self, rgba: &[u8], width: usize, height: usize, want_debug: bool) -> Vec<Reading> {
        self.discover_detail(rgba, width, height, want_debug)
            .readings
    }

    fn discover_detail(
        &self,
        rgba: &[u8],
        width: usize,
        height: usize,
        want_debug: bool,
    ) -> Discovery {
        let bounds = self
            .search_roi
            .as_ref()
            .and_then(|roi| inward_region_pixels(roi, width, height))
            .or_else(|| {
                self.search_roi.is_none().then_some(Rect {
                    x: 0.0,
                    y: 0.0,
                    width: width as f64,
                    height: height as f64,
                })
            });
        let Some(bounds) = bounds else {
            return Discovery {
                readings: Vec::new(),
                regions: Vec::new(),
                failure: None,
            };
        };
        let gray = scaled_region_gray(rgba, width, &bounds, 960);
        let scale_x = bounds.width / gray.width as f64;
        let scale_y = bounds.height / gray.height as f64;
        let mut regions: Vec<Rect> = Vec::new();
        for threshold in [180, 135, 215] {
            let binary = threshold_gray(&gray, threshold);
            for rect in clock_regions(&binary) {
                let native = Rect {
                    x: bounds.x + (rect.x * scale_x).floor(),
                    y: bounds.y + (rect.y * scale_y).floor(),
                    width: (rect.width * scale_x).ceil(),
                    height: (rect.height * scale_y).ceil(),
                };
                let Some(native) = intersect_rect(&native, &bounds) else {
                    continue;
                };
                // Every local read already tries all thresholds, so overlapping geometry
                // across discovery thresholds needs only one native-resolution OCR pass.
                if let Some(existing) = regions
                    .iter_mut()
                    .find(|candidate| same_region(candidate, &native))
                {
                    *existing = union_rect(existing, &native);
                } else if regions.len() < MAX_CANDIDATES * 3 {
                    regions.push(native);
                }
            }
        }
        let mut found = Vec::new();
        let mut failure: Option<ReadAttempt> = None;
        for region in &regions {
            let mut attempt = self.read_rect_detail(rgba, width, height, region, want_debug);
            if let Some(reading) = attempt.reading.take() {
                found.push(reading);
                // A second readable candidate is already sufficient to refuse selection.
                if found.len() >= 2 {
                    break;
                }
            } else if want_debug
                && failure.as_ref().is_none_or(|previous| {
                    debug_quality(&attempt.debug) > debug_quality(&previous.debug)
                })
            {
                failure = Some(attempt);
            }
        }
        Discovery {
            readings: found,
            regions,
            failure,
        }
    }

    #[cfg(test)]
    fn read_rect(
        &self,
        rgba: &[u8],
        width: usize,
        height: usize,
        rect: &Rect,
        want_debug: bool,
    ) -> Option<Reading> {
        self.read_rect_detail(rgba, width, height, rect, want_debug)
            .reading
    }

    fn read_rect_detail(
        &self,
        rgba: &[u8],
        width: usize,
        height: usize,
        rect: &Rect,
        want_debug: bool,
    ) -> ReadAttempt {
        let Some(rect) = clipped_rect(rect, width, height) else {
            return ReadAttempt {
                reading: None,
                debug: Value::Null,
                threshold: None,
                reason: "decode-failed",
            };
        };
        let gray = native_gray(rgba, width, &rect);
        let mut best: Option<(String, f64, f64, Vec<f64>, Value, u8, Rect)> = None;
        let mut failed_debug = Value::Null;
        let mut failed_threshold = None;
        let mut failed_reason = "no-candidates";
        let segment_options = json!({"minGlyphWidth":1,"minInkRatio":0.02});
        let preferred_threshold = self
            .track
            .as_ref()
            .filter(|track| track.layout.confirmed && same_region(&track.layout.rect, &rect))
            .map(|track| track.layout.threshold);
        let mut thresholds = [180, 135, 215];
        if let Some(index) = thresholds
            .iter()
            .position(|threshold| Some(*threshold) == preferred_threshold)
        {
            thresholds.swap(0, index);
        }
        for threshold in thresholds {
            let binary = threshold_gray(&gray, threshold);
            let mut segmented = segment_glyphs(&binary, &segment_options);
            if let Some(split) = self.split_seconds_pair(&gray, &binary, &segmented.boxes) {
                segmented.boxes = split;
            }
            let mut text = String::new();
            let mut scores = Vec::new();
            let mut normalized = Vec::new();
            let mut matches = Vec::new();
            let count_valid = matches!(segmented.boxes.len(), 4 | 5);
            let mut valid = count_valid;
            let colon_index = segmented.boxes.len().saturating_sub(3);
            let digit_height = segmented
                .boxes
                .iter()
                .enumerate()
                .filter(|(index, _)| *index != colon_index)
                .map(|(_, glyph)| glyph.height)
                .fold(0.0_f64, f64::max);
            for (index, glyph) in segmented.boxes.iter().enumerate().take(if want_debug {
                32
            } else if count_valid {
                5
            } else {
                0
            }) {
                let mask = normalize_glyph(&crop_binary(&binary, &glyph.rect()));
                let source = crop_binary(&gray, &glyph.rect());
                let (char, score, runner) = self.match_glyph(&mask, &source);
                let full_digit = index == colon_index
                    || (glyph.width <= glyph.height * 0.95 && glyph.height >= digit_height * 0.80);
                if !full_digit || score < MIN_SCORE || score - runner < MIN_MARGIN {
                    valid = false;
                    if !want_debug {
                        break;
                    }
                }
                text.push_str(char);
                scores.push(score);
                if want_debug {
                    normalized.push(mask);
                    matches.push(
                        json!({"char":char,"score":score,"runnerUpScore":runner,"sampleIndex":0}),
                    );
                }
            }
            let parsed = if matches!(text.len(), 4 | 5) && text.contains(':') {
                parse_countdown(&text, if text.len() == 4 { "m:ss" } else { "mm:ss" })
            } else {
                None
            };
            let debug = if want_debug {
                json!({"roiPixels":rect,"binary":binary,"boxes":segmented.boxes,
                "projection":segmented.projection,"inkRatio":crate::ink_ratio(&binary),"matches":matches,"normalized":normalized})
            } else {
                Value::Null
            };
            let formal =
                parsed.is_some_and(|seconds| seconds > 0.0 && seconds <= MAX_FORMAL_SECONDS);
            if !valid || !formal {
                let reason = if !count_valid {
                    "no-candidates"
                } else if !valid {
                    "low-confidence"
                } else {
                    "invalid-format"
                };
                if !want_debug {
                    failed_reason = reason;
                }
                if want_debug
                    && (failed_threshold.is_none()
                        || debug_quality(&debug) > debug_quality(&failed_debug))
                {
                    failed_debug = debug;
                    failed_threshold = Some(threshold);
                    failed_reason = reason;
                }
                continue;
            }
            let seconds = parsed.unwrap();
            let confidence = scores.iter().copied().fold(1.0_f64, f64::min);
            if best.as_ref().is_some_and(|reading| reading.2 >= confidence) {
                continue;
            }
            let glyph_rect = segmented
                .boxes
                .iter()
                .map(GlyphBox::rect)
                .reduce(|left, right| union_rect(&left, &right))
                .unwrap();
            best = Some((
                text, seconds, confidence, scores, debug, threshold, glyph_rect,
            ));
        }
        if let Some((text, seconds, confidence, scores, debug, threshold, glyph_rect)) = best {
            ReadAttempt {
                reading: Some(Reading {
                    rect,
                    text,
                    seconds,
                    confidence,
                    scores,
                    gray,
                    debug,
                    threshold,
                    glyph_rect,
                }),
                debug: Value::Null,
                threshold: Some(threshold),
                reason: "low-confidence",
            }
        } else {
            ReadAttempt {
                reading: None,
                debug: failed_debug,
                threshold: failed_threshold,
                reason: failed_reason,
            }
        }
    }

    fn split_seconds_pair(
        &self,
        gray: &Image,
        binary: &Image,
        boxes: &[GlyphBox],
    ) -> Option<Vec<GlyphBox>> {
        // Only the missing final seconds separator may be repaired. Neither a
        // minute digit nor arbitrary wide text is split to manufacture a clock.
        if !matches!(boxes.len(), 3 | 4) {
            return None;
        }
        let colon_index = boxes.len() - 2;
        if boxes[colon_index].height >= boxes.last()?.height * 0.90
            || boxes[colon_index].width >= boxes.last()?.height * 0.45
        {
            return None;
        }
        let colon = normalize_glyph(&crop_binary(binary, &boxes[colon_index].rect()));
        let source = crop_binary(gray, &boxes[colon_index].rect());
        let (symbol, score, runner) = self.match_glyph(&colon, &source);
        if symbol != ":" || score < MIN_SCORE || score - runner < MIN_MARGIN {
            return None;
        }
        let blob = boxes.last()?;
        if blob.width < blob.height * 0.70 || blob.width > blob.height * 1.8 {
            return None;
        }
        let image = crop_binary(binary, &blob.rect());
        let whole = normalize_glyph(&image);
        let (symbol, score, runner) = self.match_mask_nominal(&whole);
        // A convincingly recognized single wide digit must remain one digit.
        if symbol != ":" && score >= MIN_SCORE && score - runner >= MIN_MARGIN {
            return None;
        }
        let projection = crate::column_projection(&image);
        let min_width = (image.height as f64 * 0.12).ceil().max(2.0) as usize;
        let max_valley = (image.height as f64 * 0.25).floor().max(1.0) as usize;
        let mut valleys: Vec<_> = (min_width..image.width.saturating_sub(min_width))
            .filter(|&cut| {
                let valley = projection[cut - 1].min(projection[cut]);
                valley <= max_valley
                    && projection[..cut].iter().copied().max().unwrap_or(0) >= (valley * 2).max(3)
                    && projection[cut..].iter().copied().max().unwrap_or(0) >= (valley * 2).max(3)
            })
            .collect();
        valleys.sort_by_key(|&cut| projection[cut - 1].min(projection[cut]));
        let mut accepted: Option<(String, f64, GlyphBox, GlyphBox)> = None;
        for cut in valleys.into_iter().take(12) {
            let Some(left) = sub_glyph(&image, 0, cut, blob.x, blob.y) else {
                continue;
            };
            let Some(right) = sub_glyph(&image, cut, image.width - cut, blob.x, blob.y) else {
                continue;
            };
            if [left.height, right.height]
                .into_iter()
                .any(|height| height < blob.height * 0.75)
                || [left.width, right.width]
                    .into_iter()
                    .any(|width| width > blob.height * 0.95)
            {
                continue;
            }
            let mut pair = String::new();
            let mut confidence = 1.0_f64;
            for glyph in [&left, &right] {
                let mask = normalize_glyph(&crop_binary(binary, &glyph.rect()));
                let source = crop_binary(gray, &glyph.rect());
                let (symbol, score, runner) = self.match_glyph(&mask, &source);
                if symbol.len() != 1
                    || !symbol.as_bytes()[0].is_ascii_digit()
                    || score < MIN_SCORE
                    || score - runner < MIN_MARGIN
                {
                    pair.clear();
                    break;
                }
                pair.push_str(symbol);
                confidence = confidence.min(score);
            }
            if pair.len() != 2 || pair.as_bytes()[0] > b'5' {
                continue;
            }
            if let Some((previous, _, _, _)) = &accepted {
                if previous != &pair {
                    return None;
                }
            }
            if accepted
                .as_ref()
                .is_none_or(|previous| confidence > previous.1)
            {
                accepted = Some((pair, confidence, left, right));
            }
        }
        let (_, _, left, right) = accepted?;
        let mut result = boxes[..boxes.len() - 1].to_vec();
        result.extend([left, right]);
        Some(result)
    }

    fn match_glyph(&self, mask: &[u8], gray: &Image) -> (&str, f64, f64) {
        let packed = PackedMask::new(mask);
        let evidence = glyph_topology(gray);
        let nominal = self.match_topology(&packed, &evidence, false);
        if (nominal.1 >= MIN_SCORE && nominal.1 - nominal.2 >= MIN_MARGIN) || nominal.1 < 0.70 {
            return nominal;
        }
        let compensated = self.match_topology(&packed, &evidence, true);
        if compensated.0 == nominal.0 {
            compensated
        } else {
            nominal
        }
    }

    fn match_topology(
        &self,
        packed: &PackedMask,
        evidence: &(u8, [u8; 4]),
        boundary: bool,
    ) -> (&str, f64, f64) {
        let (mut best, mut score, mut runner) = ("", 0.0, 0.0);
        for (symbol, samples) in &self.templates {
            let value = samples
                .iter()
                .filter(|sample| {
                    sample.valid_character_topology(symbol) && sample.same_source_topology(evidence)
                })
                .map(|sample| {
                    if boundary {
                        packed.boundary_score(sample)
                    } else {
                        packed.score(sample)
                    }
                })
                .fold(0.0_f64, f64::max);
            if value > score {
                runner = score;
                score = value;
                best = symbol;
            } else if value > runner {
                runner = value;
            }
        }
        (best, score, runner)
    }

    fn match_mask_nominal(&self, mask: &[u8]) -> (&str, f64, f64) {
        let packed = PackedMask::new(mask);
        let (mut best, mut score, mut runner) = ("", 0.0, 0.0);
        for (symbol, samples) in &self.templates {
            let value = samples
                .iter()
                .map(|sample| packed.score(sample))
                .fold(0.0_f64, f64::max);
            if value > score {
                runner = score;
                score = value;
                best = symbol;
            } else if value > runner {
                runner = value;
            }
        }
        (best, score, runner)
    }
}

fn sub_glyph(
    image: &Image,
    x: usize,
    width: usize,
    offset_x: f64,
    offset_y: f64,
) -> Option<GlyphBox> {
    let crop = crop_binary(
        image,
        &Rect {
            x: x as f64,
            y: 0.0,
            width: width as f64,
            height: image.height as f64,
        },
    );
    let bounds = bounding_box(&crop)?;
    Some(GlyphBox {
        x: offset_x + x as f64 + bounds.x,
        y: offset_y + bounds.y,
        width: bounds.width,
        height: bounds.height,
        ink: crop.data.iter().filter(|&&pixel| pixel != 0).count() as f64,
    })
}

fn debug_quality(debug: &Value) -> f64 {
    let count = debug["boxes"].as_array().map(Vec::len).unwrap_or(0);
    let count_score = if matches!(count, 4 | 5) {
        2.0
    } else if count > 0 {
        1.0
    } else {
        0.0
    };
    let matches = debug["matches"].as_array();
    count_score
        + matches
            .map(|matches| {
                matches
                    .iter()
                    .map(|item| item["score"].as_f64().unwrap_or(0.0))
                    .sum::<f64>()
                    / matches.len().max(1) as f64
            })
            .unwrap_or(0.0)
}
fn with_attempt(mut result: Value, attempt: Option<ReadAttempt>) -> Value {
    if let Some(attempt) = attempt {
        if !attempt.debug.is_null() {
            result["debug"] = attempt.debug;
        }
        if let Some(threshold) = attempt.threshold {
            result["basic"]["threshold"] = json!(threshold);
        }
    }
    result
}

fn new_track(reading: &Reading, time: f64) -> Track {
    let pad_x = reading.glyph_rect.height * 0.5;
    let pad_y = reading.glyph_rect.height * 0.1;
    let mut timing_rect = clipped_rect(
        &Rect {
            x: (reading.glyph_rect.x - pad_x).max(0.0),
            y: (reading.glyph_rect.y - pad_y).max(0.0),
            width: reading.glyph_rect.width + pad_x * 2.0,
            height: reading.glyph_rect.height + pad_y * 2.0,
        },
        reading.gray.width,
        reading.gray.height,
    )
    .unwrap_or_else(|| reading.glyph_rect.clone());
    // Store frame coordinates so later envelope growth and memory promotion
    // cannot shift the cached timing crop away from its original glyphs.
    timing_rect.x += reading.rect.x;
    timing_rect.y += reading.rect.y;
    let mut timing = new_timing();
    timing.value = Some(reading.seconds);
    timing.pending = Some(reading.seconds);
    timing.pending_at = time;
    timing.last_seen = Some(time);
    Track {
        layout: ClockLayout {
            rect: reading.rect.clone(),
            timing_rect,
            threshold: reading.threshold,
            confirmed: false,
        },
        timing,
    }
}

fn new_timing() -> ClockTiming {
    ClockTiming {
        value: None,
        pending: None,
        pending_frames: 0,
        pending_at: f64::NEG_INFINITY,
        last_change: None,
        decrements: 0,
        last_seen: None,
        tick: TickMomentDetector::new(),
        pending_tick: None,
        invalidated: false,
    }
}
fn parse_region(roi_json: &str) -> Result<Option<RoiRect>, String> {
    if roi_json.len() > 1024 {
        return Err("识别范围格式无效".into());
    }
    let roi: Option<RoiRect> = serde_json::from_str(roi_json).map_err(|_| "识别范围格式无效")?;
    if let Some(roi) = &roi {
        if ![roi.x, roi.y, roi.w, roi.h].into_iter().all(f64::is_finite)
            || roi.x < 0.0
            || roi.y < 0.0
            || roi.w <= 0.0
            || roi.h <= 0.0
            || roi.x + roi.w > 1.0
            || roi.y + roi.h > 1.0
        {
            return Err("识别范围必须在画面内且宽高大于零".into());
        }
    }
    Ok(roi)
}
fn inward_region_pixels(roi: &RoiRect, width: usize, height: usize) -> Option<Rect> {
    let x = (roi.x * width as f64).ceil();
    let y = (roi.y * height as f64).ceil();
    let right = ((roi.x + roi.w) * width as f64).floor();
    let bottom = ((roi.y + roi.h) * height as f64).floor();
    (right > x && bottom > y).then_some(Rect {
        x,
        y,
        width: right - x,
        height: bottom - y,
    })
}
fn intersect_rect(rect: &Rect, bounds: &Rect) -> Option<Rect> {
    let x = rect.x.max(bounds.x);
    let y = rect.y.max(bounds.y);
    let right = (rect.x + rect.width).min(bounds.x + bounds.width);
    let bottom = (rect.y + rect.height).min(bounds.y + bounds.height);
    (right > x && bottom > y).then_some(Rect {
        x,
        y,
        width: right - x,
        height: bottom - y,
    })
}
fn threshold_gray(gray: &Image, threshold: u8) -> Image {
    // Basic clocks use scale=1 and bright polarity, so integer comparison is
    // exactly the generic preprocessing result without its per-pixel float work.
    Image {
        data: gray
            .data
            .iter()
            .map(|&pixel| if pixel >= threshold { 255 } else { 0 })
            .collect(),
        width: gray.width,
        height: gray.height,
    }
}
fn failed(status: &str, reason: &str, detail: &str, roi: Option<Value>) -> Value {
    let mut basic = json!({"status":status});
    if let Some(roi) = roi {
        basic["roi"] = roi;
    }
    json!({"outcome":{"status":"failed","reason":reason,"detail":detail},"debug":null,"basic":basic})
}
fn roi_json(rect: &Rect, width: usize, height: usize) -> Value {
    json!({"x":rect.x / width as f64,"y":rect.y / height as f64,
        "w":rect.width / width as f64,"h":rect.height / height as f64})
}
fn clipped_rect(rect: &Rect, width: usize, height: usize) -> Option<Rect> {
    let x = rect.x.floor().max(0.0).min(width as f64);
    let y = rect.y.floor().max(0.0).min(height as f64);
    let right = (rect.x + rect.width).ceil().min(width as f64);
    let bottom = (rect.y + rect.height).ceil().min(height as f64);
    (right > x && bottom > y).then_some(Rect {
        x,
        y,
        width: right - x,
        height: bottom - y,
    })
}
fn union_rect(a: &Rect, b: &Rect) -> Rect {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    Rect {
        x,
        y,
        width: (a.x + a.width).max(b.x + b.width) - x,
        height: (a.y + a.height).max(b.y + b.height) - y,
    }
}
fn same_region(a: &Rect, b: &Rect) -> bool {
    let intersection = ((a.x + a.width).min(b.x + b.width) - a.x.max(b.x)).max(0.0)
        * ((a.y + a.height).min(b.y + b.height) - a.y.max(b.y)).max(0.0);
    intersection / (a.width * a.height).min(b.width * b.height).max(1.0) > 0.72
        && a.width.max(b.width) / a.width.min(b.width).max(1.0) < 1.45
        && a.height.max(b.height) / a.height.min(b.height).max(1.0) < 1.35
}
fn native_gray(rgba: &[u8], width: usize, rect: &Rect) -> Image {
    let w = rect.width as usize;
    let h = rect.height as usize;
    let mut data = Vec::with_capacity(w * h);
    for y in rect.y as usize..rect.y as usize + h {
        for x in rect.x as usize..rect.x as usize + w {
            let index = (y * width + x) * 4;
            data.push(
                ((rgba[index] as u32 * 77
                    + rgba[index + 1] as u32 * 150
                    + rgba[index + 2] as u32 * 29)
                    >> 8) as u8,
            );
        }
    }
    Image {
        data,
        width: w,
        height: h,
    }
}
#[cfg(test)]
fn discovery_gray(rgba: &[u8], width: usize, height: usize) -> Image {
    scaled_gray(rgba, width, height, 960)
}
fn scaled_gray(rgba: &[u8], width: usize, height: usize, max_width: usize) -> Image {
    scaled_region_gray(
        rgba,
        width,
        &Rect {
            x: 0.0,
            y: 0.0,
            width: width as f64,
            height: height as f64,
        },
        max_width,
    )
}
fn scaled_region_gray(rgba: &[u8], frame_width: usize, region: &Rect, max_width: usize) -> Image {
    let source_width = region.width as usize;
    let source_height = region.height as usize;
    let scale = (source_width as f64 / max_width as f64).max(1.0);
    let w = (source_width as f64 / scale).round().max(1.0) as usize;
    let h = (source_height as f64 / scale).round().max(1.0) as usize;
    let mut data = Vec::with_capacity(w * h);
    let x_offsets: Vec<_> = (0..w)
        .map(|x| {
            ((region.x as usize)
                + (((2 * x as u64 + 1) * source_width as u64) / (2 * w as u64)) as usize)
                .min(frame_width - 1)
                * 4
        })
        .collect();
    for y in 0..h {
        let source_y = region.y as usize
            + (((2 * y as u64 + 1) * source_height as u64) / (2 * h as u64)) as usize;
        let row = source_y * frame_width * 4;
        for x_offset in &x_offsets {
            let index = row + x_offset;
            data.push(
                ((rgba[index] as u32 * 77
                    + rgba[index + 1] as u32 * 150
                    + rgba[index + 2] as u32 * 29)
                    >> 8) as u8,
            );
        }
    }
    Image {
        data,
        width: w,
        height: h,
    }
}

fn components(image: &Image) -> Vec<Component> {
    // Connected horizontal runs retain the exact 8-neighbour geometry without
    // allocating a pixel queue or visiting eight neighbours for every bright pixel.
    let mut labels: Vec<Component> = Vec::new();
    let mut parents = Vec::new();
    let mut previous: Vec<(usize, usize, usize)> = Vec::new();
    let mut current = Vec::new();
    // Search bands can be only slightly taller than the clock. The glyph size
    // ceiling is independent of how tightly the user bounded the search area.
    let max_height = 180;
    for y in 0..image.height {
        current.clear();
        let row = &image.data[y * image.width..(y + 1) * image.width];
        let (mut x, mut prior) = (0, 0);
        while x < image.width {
            if row[x] == 0 {
                x += 1;
                continue;
            }
            let start = x;
            while x < image.width && row[x] != 0 {
                x += 1;
            }
            let end = x;
            while prior < previous.len() && previous[prior].1 < start {
                prior += 1;
            }
            let mut neighbour = prior;
            let mut label = None;
            while neighbour < previous.len() && previous[neighbour].0 <= end {
                let root = component_root(&mut parents, previous[neighbour].2);
                label = Some(if let Some(existing) = label {
                    merge_components(&mut parents, &mut labels, existing, root)
                } else {
                    root
                });
                neighbour += 1;
            }
            let label = label.unwrap_or_else(|| {
                let label = labels.len();
                labels.push(Component {
                    x: start,
                    y,
                    w: end - start,
                    h: 1,
                    ink: 0,
                });
                parents.push(label);
                label
            });
            if labels.len() > 65_536 {
                return Vec::new();
            }
            let component = &mut labels[label];
            let right = component.right().max(end);
            component.x = component.x.min(start);
            component.w = right - component.x;
            component.h = y + 1 - component.y;
            component.ink += end - start;
            current.push((start, end, label));
        }
        std::mem::swap(&mut previous, &mut current);
    }
    let mut result = Vec::new();
    for (index, component) in labels.into_iter().enumerate() {
        if parents[index] == index
            && component.w <= max_height
            && component.h <= max_height
            && component.ink >= 2
        {
            result.push(component);
            if result.len() > 4096 {
                return Vec::new();
            }
        }
    }
    result
}

fn component_root(parents: &mut [usize], mut label: usize) -> usize {
    while parents[label] != label {
        parents[label] = parents[parents[label]];
        label = parents[label];
    }
    label
}
fn merge_components(
    parents: &mut [usize],
    components: &mut [Component],
    a: usize,
    b: usize,
) -> usize {
    let a = component_root(parents, a);
    let b = component_root(parents, b);
    if a == b {
        return a;
    }
    let (root, child) = (a.min(b), a.max(b));
    let right = components[root].right().max(components[child].right());
    let bottom = components[root].bottom().max(components[child].bottom());
    let left = components[root].x.min(components[child].x);
    let top = components[root].y.min(components[child].y);
    let ink = components[root].ink + components[child].ink;
    components[root] = Component {
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
        ink,
    };
    parents[child] = root;
    root
}

fn clock_regions(image: &Image) -> Vec<Rect> {
    let all = components(image);
    let dots: Vec<_> = all
        .iter()
        .filter(|component| {
            component.w >= 1
                && component.h >= 1
                && component.w <= 24
                && component.h <= 24
                && (0.35..=2.5).contains(&(component.w as f64 / component.h as f64))
                && component.ink as f64 / (component.w * component.h) as f64 >= 0.30
        })
        .collect();
    // Busy textures are not a reason to spend unbounded work pairing punctuation.
    if dots.len() > 512 {
        return Vec::new();
    }
    let digits: Vec<_> = all
        .iter()
        .filter(|component| {
            component.h >= 6
                && component.w as f64 / component.h as f64 >= 0.075
                && component.w as f64 / component.h as f64 <= 1.15
                && component.ink as f64 / (component.w * component.h) as f64 >= 0.07
        })
        .collect();
    let paired_digits: Vec<_> = all
        .iter()
        .filter(|component| {
            component.h >= 6
                && (0.90..=1.8).contains(&(component.w as f64 / component.h as f64))
                && component.ink as f64 / (component.w * component.h) as f64 >= 0.07
        })
        .collect();
    let mut regions = Vec::new();
    for (at, upper) in dots.iter().enumerate() {
        for lower in &dots[at + 1..] {
            let (upper, lower) = if upper.y < lower.y {
                (*upper, *lower)
            } else {
                (*lower, *upper)
            };
            let dot_h = upper.h.max(lower.h) as f64;
            if upper.bottom() >= lower.y
                || (upper.cx() - lower.cx()).abs() > upper.w.max(lower.w) as f64 * 0.65
                || upper.h.max(lower.h) as f64 / upper.h.min(lower.h) as f64 > 1.8
                || !(0.25 * dot_h..=7.0 * dot_h).contains(&((lower.y - upper.bottom()) as f64))
            {
                continue;
            }
            let colon_x = upper.x.min(lower.x);
            let colon_right = upper.right().max(lower.right());
            let colon_y = upper.y;
            let colon_bottom = lower.bottom();
            let colon_height = (colon_bottom - colon_y) as f64;
            let center_y = (colon_y + colon_bottom) as f64 / 2.0;
            let mut left: Vec<_> = digits
                .iter()
                .copied()
                .filter(|digit| {
                    digit.right() <= colon_x
                        && colon_x - digit.right() <= (colon_height * 3.5) as usize
                        && row_matches(digit, colon_height, center_y)
                })
                .collect();
            let mut right: Vec<_> = digits
                .iter()
                .copied()
                .filter(|digit| {
                    digit.x >= colon_right
                        && digit.x - colon_right <= (colon_height * 4.0) as usize
                        && row_matches(digit, colon_height, center_y)
                })
                .collect();
            left.sort_by_key(|digit| std::cmp::Reverse(digit.right()));
            right.sort_by_key(|digit| digit.x);
            if left.is_empty() {
                continue;
            }
            let first = left[0];
            // A downscaled narrow gap may join the two seconds glyphs into one
            // component. Geometry only proposes this envelope; native OCR must
            // subsequently find a pixel valley and confidently read both halves.
            if let Some(pair) = paired_digits
                .iter()
                .copied()
                .filter(|pair| {
                    pair.x >= colon_right
                        && pair.x - colon_right <= (colon_height * 0.85) as usize
                        && row_matches(pair, colon_height, center_y)
                })
                .min_by_key(|pair| pair.x)
            {
                let digit_height = first.h.max(pair.h) as f64;
                let continuation = digits.iter().any(|digit| {
                    digit.x >= pair.right()
                        && digit.x - pair.right() <= (digit_height * 0.16).ceil() as usize
                        && row_matches(digit, colon_height, center_y)
                });
                let separate_pair = right.iter().any(|digit| {
                    digit.x >= pair.x && digit.right() <= pair.right() && digit.x != pair.x
                });
                if !continuation
                    && !separate_pair
                    && (colon_x - first.right()) as f64 <= digit_height * 0.60
                {
                    let start = left
                        .get(1)
                        .copied()
                        .filter(|digit| {
                            digit.right() <= first.x
                                && (first.x - digit.right()) as f64
                                    <= (digit_height * 0.16).max(1.0)
                        })
                        .unwrap_or(first);
                    let y = start.y.min(first.y).min(pair.y).min(colon_y);
                    let bottom = start
                        .bottom()
                        .max(first.bottom())
                        .max(pair.bottom())
                        .max(colon_bottom);
                    let pad = (digit_height * 0.10).ceil().max(2.0);
                    let rect = Rect {
                        x: (start.x as f64 - pad).max(0.0),
                        y: (y as f64 - pad).max(0.0),
                        width: pair.right() as f64 - start.x as f64 + pad * 2.0,
                        height: bottom as f64 - y as f64 + pad * 2.0,
                    };
                    if (1.0..=4.4).contains(&(rect.width / rect.height))
                        && !regions.iter().any(|existing| same_region(existing, &rect))
                    {
                        regions.push(rect);
                    }
                }
            }
            if right.len() < 2 {
                continue;
            }
            let tens = right[0];
            let units = right[1];
            let digit_height = [first.h, tens.h, units.h].into_iter().max().unwrap() as f64;
            if (colon_x - first.right()) as f64 > digit_height * 0.60
                || (tens.x - colon_right) as f64 > digit_height * 0.60
                || units.x < tens.right()
                || (units.x - tens.right()) as f64 > digit_height * 0.65
            {
                continue;
            }
            // A second minute digit belongs only if its gap agrees with the clock's own tracking.
            let usual_gap = (units.x - tens.right()).max(1) as f64;
            // An equally spaced continuation makes the final seconds digit ambiguous.
            if right.get(2).is_some_and(|digit| {
                digit.x >= units.right()
                    && (digit.x - units.right()) as f64
                        <= (usual_gap * 1.8).max(digit_height * 0.16)
            }) {
                continue;
            }
            let start = left
                .get(1)
                .copied()
                .filter(|digit| {
                    digit.right() <= first.x
                        && (first.x - digit.right()) as f64
                            <= (usual_gap * 1.8).max(digit_height * 0.16)
                })
                .unwrap_or(first);
            let x = start.x;
            let y = [start.y, first.y, tens.y, units.y, colon_y]
                .into_iter()
                .min()
                .unwrap();
            let bottom = [
                start.bottom(),
                first.bottom(),
                tens.bottom(),
                units.bottom(),
                colon_bottom,
            ]
            .into_iter()
            .max()
            .unwrap();
            let pad = (digit_height * 0.10).ceil().max(2.0);
            let rect = Rect {
                x: (x as f64 - pad).max(0.0),
                y: (y as f64 - pad).max(0.0),
                width: units.right() as f64 - x as f64 + pad * 2.0,
                height: bottom as f64 - y as f64 + pad * 2.0,
            };
            if rect.width / rect.height > 4.4 || rect.width / rect.height < 1.0 {
                continue;
            }
            if !regions.iter().any(|existing| same_region(existing, &rect)) {
                regions.push(rect);
            }
            if regions.len() >= MAX_CANDIDATES {
                return regions;
            }
        }
    }
    regions
}
fn row_matches(digit: &Component, colon_height: f64, center_y: f64) -> bool {
    digit.h as f64 >= colon_height * 0.85
        && digit.h as f64 <= colon_height * 2.5
        && (digit.cy() - center_y).abs() <= digit.h as f64 * 0.26
}

#[cfg(test)]
#[path = "basic_clock_tests.rs"]
mod tests;
