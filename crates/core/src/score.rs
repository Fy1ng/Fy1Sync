//! Conservative, explicitly labeled integer recognition next to a confirmed clock.
//! Score glyphs never acquire labels from countdown progression.

use crate::{score_masks, unpack_bitmap, Image, RoiRect};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[path = "score_templates.rs"]
mod templates;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreReading {
    pub left: Option<u8>,
    pub right: Option<u8>,
    pub left_quality: f64,
    pub right_quality: f64,
    pub reason: Option<String>,
    pub style: Option<String>,
}

#[derive(Clone)]
struct LabeledGlyph {
    digit: u8,
    style: &'static str,
    mask: Vec<u8>,
}

#[derive(Clone, Copy, Debug)]
struct Component {
    x: usize,
    y: usize,
    w: usize,
    h: usize,
    ink: usize,
}

fn bank() -> &'static [LabeledGlyph] {
    static BANK: OnceLock<Vec<LabeledGlyph>> = OnceLock::new();
    BANK.get_or_init(|| {
        templates::SCORE_TEMPLATES
            .iter()
            .map(|&(digit, style, data)| LabeledGlyph {
                digit,
                style,
                mask: unpack_bitmap(data, 32 * 48).expect("checked score bitmap"),
            })
            .collect()
    })
}

fn empty(reason: &str) -> ScoreReading {
    ScoreReading {
        left: None,
        right: None,
        left_quality: 0.0,
        right_quality: 0.0,
        reason: Some(reason.into()),
        style: None,
    }
}

/// The ROI is relative to the supplied native strip, not to a CSS player box.
/// The strip must include the clock plus 2.2 clock widths on each side and
/// 0.8 clock heights above/below. Pixels outside the derived candidates are ignored.
pub fn recognize_score(rgba: &[u8], width: usize, height: usize, clock: &RoiRect) -> ScoreReading {
    let Some(size) = width
        .checked_mul(height)
        .filter(|&n| n > 0 && n <= 16_777_216)
    else {
        return empty("invalid-frame");
    };
    if rgba.len() != size.saturating_mul(4) {
        return empty("invalid-frame");
    }
    if ![clock.x, clock.y, clock.w, clock.h]
        .iter()
        .all(|v| v.is_finite())
        || clock.x < 0.0
        || clock.y < 0.0
        || clock.w <= 0.0
        || clock.h <= 0.0
        || clock.x + clock.w > 1.000001
        || clock.y + clock.h > 1.000001
    {
        return empty("invalid-clock-roi");
    }
    let x = clock.x * width as f64;
    let y = clock.y * height as f64;
    let w = clock.w * width as f64;
    let h = clock.h * height as f64;
    if w < 5.0 || h < 5.0 {
        return empty("clock-too-small");
    }
    let side = |left| read_side(rgba, width, height, x, y, w, h, left, bank());
    let l = side(true);
    let r = side(false);
    ScoreReading {
        left: l.value,
        right: r.value,
        left_quality: l.quality,
        right_quality: r.quality,
        reason: if l.value.is_some() && r.value.is_some() {
            None
        } else if l.ambiguous || r.ambiguous {
            Some("ambiguous-candidates".into())
        } else if l.value.is_none() && r.value.is_none() {
            Some("score-unreadable".into())
        } else if l.value.is_none() {
            Some("left-unreadable".into())
        } else {
            Some("right-unreadable".into())
        },
        style: l.style.or(r.style).map(str::to_string),
    }
}

#[derive(Default)]
struct SideReading {
    value: Option<u8>,
    quality: f64,
    style: Option<&'static str>,
    ambiguous: bool,
}

fn read_side(
    rgba: &[u8],
    width: usize,
    height: usize,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    left: bool,
    templates: &[LabeledGlyph],
) -> SideReading {
    let (a, b) = if left {
        (x - 1.9 * w, x - 0.15 * w)
    } else {
        (x + 1.15 * w, x + 2.9 * w)
    };
    let x0 = a.floor().max(0.0) as usize;
    let x1 = b.ceil().min(width as f64).max(0.0) as usize;
    let y0 = (y - 0.5 * h).floor().max(0.0) as usize;
    let y1 = (y + 2.0 * h).ceil().min(height as f64).max(0.0) as usize;
    if x1 <= x0 || y1 <= y0 {
        return SideReading::default();
    }
    let mut image = Image {
        data: vec![0; (x1 - x0) * (y1 - y0)],
        width: x1 - x0,
        height: y1 - y0,
    };
    for yy in y0..y1 {
        for xx in x0..x1 {
            let p = (yy * width + xx) * 4;
            // Colored score strokes are often below the clock's grayscale threshold.
            image.data[(yy - y0) * image.width + xx - x0] =
                if rgba[p].max(rgba[p + 1]).max(rgba[p + 2]) > 150 {
                    255
                } else {
                    0
                };
        }
    }
    let mut boxes: Vec<_> = components(&image)
        .into_iter()
        .filter(|b| {
            b.h as f64 >= h * 1.05
                && b.h as f64 <= h * 2.15
                && b.w as f64 >= b.h as f64 * 0.09
                && b.w as f64 <= b.h as f64 * 1.05
                && b.ink >= 8
                && b.ink as f64 >= (b.w * b.h) as f64 * 0.15
                && ((y0 + b.y) as f64 - y).abs() <= h * 0.75
        })
        .collect();
    boxes.sort_by_key(|b| b.x);
    if boxes.is_empty() {
        return SideReading::default();
    }
    // A clipped digit must never become a different, shorter integer.
    if boxes
        .iter()
        .any(|b| b.x == 0 || b.x + b.w == image.width || b.y == 0 || b.y + b.h == image.height)
    {
        return SideReading::default();
    }
    // Two separate numbers in one candidate area are not resolved by picking a
    // convenient maximum. Unknown is safer than silently choosing the wrong HUD.
    if boxes.len() > 2 {
        return SideReading {
            ambiguous: true,
            ..Default::default()
        };
    }
    if boxes.len() == 2 {
        let a = boxes[0];
        let b = boxes[1];
        let gap = b.x.saturating_sub(a.x + a.w);
        if gap as f64 > h * 0.45
            || a.h.abs_diff(b.h) as f64 > h * 0.25
            || a.y.abs_diff(b.y) as f64 > h * 0.25
        {
            return SideReading {
                ambiguous: true,
                ..Default::default()
            };
        }
    }
    let mut value = 0u8;
    let mut quality = 1.0f64;
    let mut style = None;
    for (index, b) in boxes.iter().enumerate() {
        let mask = stretch(&image, *b);
        let Some((digit, score, matched_style)) = match_digit(&mask, templates) else {
            return SideReading::default();
        };
        if boxes.len() == 2 && index == 0 && digit == 0 {
            return SideReading::default();
        }
        value = value * 10 + digit;
        quality = quality.min(score);
        style = Some(matched_style);
    }
    SideReading {
        value: Some(value),
        quality,
        style,
        ambiguous: false,
    }
}

fn match_digit(mask: &[u8], templates: &[LabeledGlyph]) -> Option<(u8, f64, &'static str)> {
    let mut ranks = [(0.0, ""); 10];
    for template in templates {
        let score = score_masks(mask, &template.mask);
        let rank = &mut ranks[template.digit as usize];
        if score > rank.0 {
            *rank = (score, template.style);
        }
    }
    let mut order: Vec<_> = ranks.iter().enumerate().collect();
    order.sort_by(|a, b| b.1 .0.total_cmp(&a.1 .0));
    let (digit, &(best, style)) = order[0];
    if best < 0.78 || best - order[1].1 .0 < 0.055 {
        return None;
    }
    Some((digit as u8, best, style))
}

fn stretch(image: &Image, b: Component) -> Vec<u8> {
    (0..32 * 48)
        .map(|i| {
            let x = b.x + ((i % 32) * b.w / 32).min(b.w - 1);
            let y = b.y + ((i / 32) * b.h / 48).min(b.h - 1);
            image.data[y * image.width + x]
        })
        .collect()
}

fn components(image: &Image) -> Vec<Component> {
    let mut seen = vec![false; image.data.len()];
    let mut result = Vec::new();
    for start in 0..image.data.len() {
        if seen[start] || image.data[start] == 0 {
            continue;
        }
        seen[start] = true;
        let mut stack = vec![start];
        let (mut x0, mut y0, mut x1, mut y1, mut ink) = (image.width, image.height, 0, 0, 0);
        while let Some(p) = stack.pop() {
            let x = p % image.width;
            let y = p / image.width;
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
            ink += 1;
            for yy in y.saturating_sub(1)..=(y + 1).min(image.height - 1) {
                for xx in x.saturating_sub(1)..=(x + 1).min(image.width - 1) {
                    let n = yy * image.width + xx;
                    if !seen[n] && image.data[n] != 0 {
                        seen[n] = true;
                        stack.push(n);
                    }
                }
            }
        }
        result.push(Component {
            x: x0,
            y: y0,
            w: x1 - x0 + 1,
            h: y1 - y0 + 1,
            ink,
        });
    }
    result
}

#[cfg(test)]
#[path = "score_tests.rs"]
mod tests;
