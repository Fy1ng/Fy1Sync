use crate::{js_round, PreprocessSettings, RoiRect};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Image {
    pub data: Vec<u8>,
    pub width: usize,
    pub height: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct GlyphBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub ink: f64,
}
impl GlyphBox {
    pub fn rect(&self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentResult {
    pub boxes: Vec<GlyphBox>,
    pub projection: Vec<usize>,
    pub column_threshold: f64,
}

pub fn content_rect(vw: f64, vh: f64, ew: f64, eh: f64) -> Rect {
    if vw <= 0.0 || vh <= 0.0 || ew <= 0.0 || eh <= 0.0 {
        return Rect {
            x: 0.0,
            y: 0.0,
            width: ew.max(0.0),
            height: eh.max(0.0),
        };
    }
    let scale = (ew / vw).min(eh / vh);
    let width = vw * scale;
    let height = vh * scale;
    Rect {
        x: (ew - width) / 2.0,
        y: (eh - height) / 2.0,
        width,
        height,
    }
}
pub fn clamp01(v: f64) -> f64 {
    if !v.is_finite() {
        0.0
    } else {
        v.clamp(0.0, 1.0)
    }
}
pub fn roi_to_pixels(r: &RoiRect, w: usize, h: usize) -> Rect {
    let x = js_round(r.x * w as f64).min(w as f64 - 1.0).max(0.0);
    let y = js_round(r.y * h as f64).min(h as f64 - 1.0).max(0.0);
    Rect {
        x,
        y,
        width: js_round(r.w * w as f64).min(w as f64 - x).max(1.0),
        height: js_round(r.h * h as f64).min(h as f64 - y).max(1.0),
    }
}
pub fn normalize_roi(r: &RoiRect) -> RoiRect {
    let x = clamp01(r.x.min(r.x + r.w));
    let y = clamp01(r.y.min(r.y + r.h));
    RoiRect {
        x,
        y,
        w: clamp01(r.w.abs()).min(1.0 - x),
        h: clamp01(r.h.abs()).min(1.0 - y),
    }
}
pub fn to_grayscale(rgba: &[u8], w: usize, h: usize) -> Image {
    let data = (0..w * h)
        .map(|i| {
            let j = i * 4;
            ((rgba.get(j).copied().unwrap_or(0) as u32 * 77
                + rgba.get(j + 1).copied().unwrap_or(0) as u32 * 150
                + rgba.get(j + 2).copied().unwrap_or(0) as u32 * 29)
                >> 8) as u8
        })
        .collect();
    Image {
        data,
        width: w,
        height: h,
    }
}
pub fn binarize(image: &Image, s: &PreprocessSettings) -> Image {
    Image {
        data: image
            .data
            .iter()
            .map(|&v| {
                let boosted = js_round((v as f64 - 128.0) * s.scale + 128.0).clamp(0.0, 255.0);
                if if s.invert {
                    boosted <= s.threshold
                } else {
                    boosted >= s.threshold
                } {
                    255
                } else {
                    0
                }
            })
            .collect(),
        width: image.width,
        height: image.height,
    }
}
pub fn ink_ratio(image: &Image) -> f64 {
    if image.data.is_empty() {
        0.0
    } else {
        image.data.iter().filter(|&&v| v != 0).count() as f64 / image.data.len() as f64
    }
}
pub fn bounding_box(image: &Image) -> Option<Rect> {
    let (mut minx, mut miny, mut maxx, mut maxy) = (image.width, image.height, None, None);
    for y in 0..image.height {
        for x in 0..image.width {
            if image.data.get(y * image.width + x).copied().unwrap_or(0) != 0 {
                minx = minx.min(x);
                miny = miny.min(y);
                maxx = Some(maxx.unwrap_or(0).max(x));
                maxy = Some(maxy.unwrap_or(0).max(y));
            }
        }
    }
    maxx.map(|mx| Rect {
        x: minx as f64,
        y: miny as f64,
        width: (mx - minx + 1) as f64,
        height: (maxy.unwrap() - miny + 1) as f64,
    })
}
pub fn crop_binary(image: &Image, r: &Rect) -> Image {
    let x0 = r.x.floor().max(0.0) as usize;
    let y0 = r.y.floor().max(0.0) as usize;
    let width = r.width.floor().min(image.width as f64 - x0 as f64).max(1.0) as usize;
    let height = r
        .height
        .floor()
        .min(image.height as f64 - y0 as f64)
        .max(1.0) as usize;
    let mut data = vec![0; width * height];
    for y in 0..height {
        let start = (y0 + y) * image.width + x0;
        let end = (start + width).min(image.data.len());
        if start < end {
            data[y * width..y * width + end - start].copy_from_slice(&image.data[start..end]);
        }
    }
    Image {
        data,
        width,
        height,
    }
}
pub fn normalize_glyph_coverage(glyph: &Image) -> Vec<u8> {
    let mut out = vec![0; 1536];
    let Some(box_) = bounding_box(glyph) else {
        return out;
    };
    let tight = crop_binary(glyph, &box_);
    let scale = 48.0 / tight.height as f64;
    let tw = js_round(tight.width as f64 * scale).clamp(1.0, 32.0) as usize;
    let ox = (32 - tw) / 2;
    let sx = tight.width as f64 / tw as f64;
    let sy = tight.height as f64 / 48.0;
    let spanx = sx.max(1.0);
    let spany = sy.max(1.0);
    for ty in 0..48 {
        let cy = (ty as f64 + 0.5) * sy;
        let y0 = (cy - spany / 2.0).max(0.0);
        let y1 = (cy + spany / 2.0).min(tight.height as f64);
        for tx in 0..tw {
            let cx = (tx as f64 + 0.5) * sx;
            let x0 = (cx - spanx / 2.0).max(0.0);
            let x1 = (cx + spanx / 2.0).min(tight.width as f64);
            let (mut ink, mut total) = (0.0, 0.0);
            let mut yy = y0.floor() as usize;
            while (yy as f64) < y1 {
                let wy = ((yy + 1) as f64).min(y1) - (yy as f64).max(y0);
                if wy > 0.0 {
                    let mut xx = x0.floor() as usize;
                    while (xx as f64) < x1 {
                        let weight = wy * (((xx + 1) as f64).min(x1) - (xx as f64).max(x0));
                        if weight > 0.0 {
                            total += weight;
                            if tight.data.get(yy * tight.width + xx).copied().unwrap_or(0) != 0 {
                                ink += weight;
                            }
                        }
                        xx += 1;
                    }
                }
                yy += 1;
            }
            if total > 0.0 {
                out[ty * 32 + ox + tx] = js_round((ink / total) * 255.0) as u8;
            }
        }
    }
    out
}
pub fn threshold_coverage(c: &[u8]) -> Vec<u8> {
    c.iter().map(|&v| if v >= 128 { 255 } else { 0 }).collect()
}
pub fn normalize_glyph(g: &Image) -> Vec<u8> {
    threshold_coverage(&normalize_glyph_coverage(g))
}
pub fn column_projection(image: &Image) -> Vec<usize> {
    let mut p = vec![0; image.width];
    for y in 0..image.height {
        for (x, col) in p.iter_mut().enumerate() {
            if image.data.get(y * image.width + x).copied().unwrap_or(0) != 0 {
                *col += 1;
            }
        }
    }
    p
}
pub fn segment_glyphs(image: &Image, opt: &serde_json::Value) -> SegmentResult {
    let mc = crate::field_number(opt, "minColumnInk", 1.0);
    let mw = crate::field_number(opt, "minGlyphWidth", 2.0);
    let mg = crate::field_number(opt, "minGapWidth", 1.0);
    let mi = crate::field_number(opt, "minInkRatio", 0.08);
    let projection = column_projection(image);
    let ct = mc.max(1.0);
    let mut runs = Vec::new();
    let (mut start, mut gap) = (-1isize, 0usize);
    for (x, &n) in projection.iter().enumerate() {
        if n as f64 >= ct {
            if start < 0 {
                start = x as isize;
            } else if gap > 0 && gap as f64 >= mg {
                runs.push((start as usize, x - gap - 1));
                start = x as isize;
            }
            gap = 0;
        } else if start >= 0 {
            gap += 1;
        }
    }
    if start >= 0 {
        let end = projection.len() as isize - 1 - if gap as f64 >= mg { gap as isize } else { 0 };
        if end >= start {
            runs.push((start as usize, end as usize));
        }
    }
    let mut candidates = Vec::new();
    for (a, b) in runs {
        let width = b - a + 1;
        if (width as f64) < mw {
            continue;
        }
        let slice = crop_binary(
            image,
            &Rect {
                x: a as f64,
                y: 0.0,
                width: width as f64,
                height: image.height as f64,
            },
        );
        if let Some(bb) = bounding_box(&slice) {
            let ink = slice.data.iter().filter(|&&v| v != 0).count() as f64;
            candidates.push(GlyphBox {
                x: a as f64 + bb.x,
                y: bb.y,
                width: bb.width,
                height: bb.height,
                ink,
            });
        }
    }
    let max = candidates.iter().fold(0.0_f64, |a, b| a.max(b.ink));
    let boxes = candidates
        .into_iter()
        .filter(|b| max == 0.0 || b.ink >= max * mi)
        .collect();
    SegmentResult {
        boxes,
        projection,
        column_threshold: ct,
    }
}
pub fn merge_glyph_boxes(boxes: &[GlyphBox], from: isize, to: isize) -> Vec<GlyphBox> {
    let low = from.min(to).max(0) as usize;
    let high = from.max(to).min(boxes.len() as isize - 1);
    if high <= low as isize {
        return boxes.to_vec();
    }
    let hi = high as usize;
    let mut b = boxes[low].clone();
    for n in &boxes[low + 1..=hi] {
        let x = b.x.min(n.x);
        let y = b.y.min(n.y);
        let right = (b.x + b.width).max(n.x + n.width);
        let bottom = (b.y + b.height).max(n.y + n.height);
        b = GlyphBox {
            x,
            y,
            width: right - x,
            height: bottom - y,
            ink: b.ink + n.ink,
        };
    }
    let mut result = boxes[..low].to_vec();
    result.push(b);
    result.extend_from_slice(&boxes[hi + 1..]);
    result
}
pub fn split_glyph_box(boxes: &[GlyphBox], index: usize, at: f64) -> Vec<GlyphBox> {
    let mut out = boxes.to_vec();
    let Some(b) = boxes.get(index) else {
        return out;
    };
    let cut = js_round(at);
    if cut <= b.x || cut >= b.x + b.width {
        return out;
    }
    let lw = cut - b.x;
    let ink = js_round(b.ink * (lw / b.width));
    let left = GlyphBox {
        width: lw,
        ink,
        ..b.clone()
    };
    let right = GlyphBox {
        x: cut,
        width: b.width - lw,
        ink: b.ink - ink,
        ..b.clone()
    };
    out.splice(index..index + 1, [left, right]);
    out
}
pub fn exclude_glyph_box(boxes: &[GlyphBox], index: usize) -> Vec<GlyphBox> {
    let mut out = boxes.to_vec();
    if index < out.len() {
        out.remove(index);
    }
    out
}
pub fn adjust_glyph_box(
    boxes: &[GlyphBox],
    index: usize,
    edge: &str,
    delta: f64,
    width: f64,
    height: f64,
) -> Vec<GlyphBox> {
    let mut out = boxes.to_vec();
    let Some(b) = boxes.get(index) else {
        return out;
    };
    let mut n = b.clone();
    match edge {
        "left" => {
            let x = (b.x + delta).min(b.x + b.width - 1.0).max(0.0);
            n.width = b.x + b.width - x;
            n.x = x;
        }
        "right" => n.width = (b.x + b.width + delta).min(width).max(b.x + 1.0) - b.x,
        "top" => {
            let y = (b.y + delta).min(b.y + b.height - 1.0).max(0.0);
            n.height = b.y + b.height - y;
            n.y = y;
        }
        _ => n.height = (b.y + b.height + delta).min(height).max(b.y + 1.0) - b.y,
    }
    out[index] = n;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn luma_and_threshold() {
        let g = to_grayscale(&[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255], 3, 1);
        assert_eq!(g.data, [76, 149, 28]);
        assert_eq!(
            binarize(
                &g,
                &PreprocessSettings {
                    scale: 1.0,
                    threshold: 100.0,
                    invert: false
                }
            )
            .data,
            [0, 255, 0]
        );
    }
    #[test]
    fn layout() {
        assert_eq!(
            content_rect(1920.0, 1080.0, 800.0, 800.0),
            Rect {
                x: 0.0,
                y: 175.0,
                width: 800.0,
                height: 450.0
            }
        );
        assert_eq!(content_rect(0.0, 0.0, 300.0, 200.0).height, 200.0);
    }
    #[test]
    fn projection_and_blank() {
        let i = Image {
            data: vec![255, 0, 255, 255, 0, 0],
            width: 3,
            height: 2,
        };
        assert_eq!(column_projection(&i), [2, 0, 1]);
        assert_eq!(bounding_box(&i).unwrap().width, 3.0);
        assert!(segment_glyphs(
            &Image {
                data: vec![0; 400],
                width: 20,
                height: 20
            },
            &json!({})
        )
        .boxes
        .is_empty());
    }
    #[test]
    fn glyph_normalization() {
        let blank = Image {
            data: vec![0; 100],
            width: 10,
            height: 10,
        };
        assert_eq!(normalize_glyph(&blank), vec![0; 1536]);
        let full = Image {
            data: vec![255; 100],
            width: 10,
            height: 10,
        };
        assert_eq!(normalize_glyph(&full), vec![255; 1536]);
    }
    #[test]
    fn edit_boxes() {
        let b = vec![
            GlyphBox {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 20.0,
                ink: 40.0,
            },
            GlyphBox {
                x: 12.0,
                y: 0.0,
                width: 4.0,
                height: 20.0,
                ink: 8.0,
            },
        ];
        let m = merge_glyph_boxes(&b, 0, 1);
        assert_eq!(m[0].width, 16.0);
        assert_eq!(m[0].ink, 48.0);
        let s = split_glyph_box(&b, 0, 4.0);
        assert_eq!(s[0].ink + s[1].ink, 40.0);
        assert_eq!(
            adjust_glyph_box(&b, 0, "left", 999.0, 30.0, 20.0)[0].width,
            1.0
        );
        assert_eq!(exclude_glyph_box(&b, 1).len(), 1);
    }
}
