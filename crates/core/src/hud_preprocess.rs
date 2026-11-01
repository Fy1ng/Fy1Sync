//! Stateless HUD preprocessing and conservative, one-shot parameter recommendations.
use crate::{binarize, js_round, to_grayscale, Image, PreprocessSettings};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HudPreprocessMode {
    Gray,
    Adaptive,
    Hsv,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HudAdaptiveSettings {
    pub window_size: usize,
    pub offset: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HudHsvSettings {
    pub hue: f64,
    pub tolerance: f64,
    pub saturation_min: f64,
    pub saturation_max: f64,
    pub value_min: f64,
    pub value_max: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HudPreprocessSettings {
    pub mode: HudPreprocessMode,
    pub scale: f64,
    pub threshold: f64,
    pub invert: bool,
    pub adaptive: HudAdaptiveSettings,
    pub hsv: HudHsvSettings,
}

impl Default for HudPreprocessSettings {
    fn default() -> Self {
        Self {
            mode: HudPreprocessMode::Gray,
            scale: 1.4,
            threshold: 150.0,
            invert: false,
            adaptive: HudAdaptiveSettings { window_size: 15, offset: 7.0 },
            hsv: HudHsvSettings {
                hue: 0.0,
                tolerance: 15.0,
                saturation_min: 0.25,
                saturation_max: 1.0,
                value_min: 0.03,
                value_max: 1.0,
            },
        }
    }
}

impl HudPreprocessSettings {
    /// Internal auto-learning profiles remain grayscale; this is not a JSON migration path.
    pub fn from_internal(settings: &PreprocessSettings) -> Self {
        Self {
            scale: settings.scale,
            threshold: settings.threshold,
            invert: settings.invert,
            ..Self::default()
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        let range = |value: f64, min: f64, max: f64| value.is_finite() && value >= min && value <= max;
        if !range(self.scale, 0.1, 10.0) || !range(self.threshold, 0.0, 255.0) {
            return Err("invalid-grayscale-settings");
        }
        if !(3..=255).contains(&self.adaptive.window_size) || self.adaptive.window_size % 2 == 0
            || !range(self.adaptive.offset, 0.0, 128.0) {
            return Err("invalid-adaptive-settings");
        }
        let hsv = &self.hsv;
        if !range(hsv.hue, 0.0, 360.0) || hsv.hue == 360.0 || !range(hsv.tolerance, 0.0, 180.0)
            || !range(hsv.saturation_min, 0.0, 1.0) || !range(hsv.saturation_max, 0.0, 1.0)
            || !range(hsv.value_min, 0.0, 1.0) || !range(hsv.value_max, 0.0, 1.0)
            || hsv.saturation_min > hsv.saturation_max || hsv.value_min > hsv.value_max {
            return Err("invalid-hsv-settings");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum HudPreprocessRequest {
    Threshold {},
    Polarity {},
    Hsv { x: usize, y: usize },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HudPreprocessRecommendation {
    pub settings: Option<HudPreprocessSettings>,
    pub reason: Option<String>,
}

impl HudPreprocessRecommendation {
    fn accepted(settings: HudPreprocessSettings) -> Self {
        Self { settings: Some(settings), reason: None }
    }
    fn refused(reason: &str) -> Self {
        Self { settings: None, reason: Some(reason.into()) }
    }
}

fn boosted(gray: &Image, scale: f64) -> Vec<u8> {
    gray.data.iter().map(|&pixel| js_round((pixel as f64 - 128.0) * scale + 128.0).clamp(0.0, 255.0) as u8).collect()
}

/// Input is an already-cropped, native-sized RGBA region. Gray preview stays unmodified.
pub fn preprocess_hud_rgba(rgba: &[u8], width: usize, height: usize, settings: &HudPreprocessSettings) -> (Image, Image) {
    let gray = to_grayscale(rgba, width, height);
    let binary = match settings.mode {
        HudPreprocessMode::Gray => binarize(&gray, &PreprocessSettings {
            scale: settings.scale, threshold: settings.threshold, invert: settings.invert,
        }),
        HudPreprocessMode::Adaptive => adaptive_mask(&gray, settings),
        HudPreprocessMode::Hsv => Image {
            data: rgba.chunks_exact(4).map(|pixel| {
                let [hue, saturation, value] = rgb_to_hsv(pixel[0], pixel[1], pixel[2]);
                let hsv = &settings.hsv;
                let selected = (saturation < 1e-9 || hue_distance(hue, hsv.hue) <= hsv.tolerance)
                    && saturation >= hsv.saturation_min && saturation <= hsv.saturation_max
                    && value >= hsv.value_min && value <= hsv.value_max;
                if selected != settings.invert { 255 } else { 0 }
            }).collect(),
            width,
            height,
        },
    };
    (gray, binary)
}

fn adaptive_mask(gray: &Image, settings: &HudPreprocessSettings) -> Image {
    let pixels = boosted(gray, settings.scale);
    let stride = gray.width + 1;
    let mut integral = vec![0u64; stride * (gray.height + 1)];
    for y in 0..gray.height {
        let mut sum = 0u64;
        for x in 0..gray.width {
            sum += pixels[y * gray.width + x] as u64;
            integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + sum;
        }
    }
    let radius = settings.adaptive.window_size / 2;
    let mut data = vec![0; pixels.len()];
    for y in 0..gray.height {
        let top = y.saturating_sub(radius);
        let bottom = (y + radius + 1).min(gray.height);
        for x in 0..gray.width {
            let left = x.saturating_sub(radius);
            let right = (x + radius + 1).min(gray.width);
            let sum = integral[bottom * stride + right] + integral[top * stride + left]
                - integral[top * stride + right] - integral[bottom * stride + left];
            let mean = sum as f64 / ((bottom - top) * (right - left)) as f64;
            let pixel = pixels[y * gray.width + x] as f64;
            let selected = if settings.invert { pixel < mean - settings.adaptive.offset }
                else { pixel > mean + settings.adaptive.offset };
            data[y * gray.width + x] = if selected { 255 } else { 0 };
        }
    }
    Image { data, width: gray.width, height: gray.height }
}

fn rgb_to_hsv(red: u8, green: u8, blue: u8) -> [f64; 3] {
    let [r, g, b] = [red as f64 / 255.0, green as f64 / 255.0, blue as f64 / 255.0];
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    let hue = if delta < 1e-12 { 0.0 } else if max == r { (60.0 * ((g - b) / delta)).rem_euclid(360.0) }
        else if max == g { 60.0 * ((b - r) / delta + 2.0) } else { 60.0 * ((r - g) / delta + 4.0) };
    [hue, if max < 1e-12 { 0.0 } else { delta / max }, max]
}

fn hue_distance(a: f64, b: f64) -> f64 {
    let difference = (a - b).abs().rem_euclid(360.0);
    difference.min(360.0 - difference)
}

/// A gap midpoint avoids turning a uniform histogram cluster into foreground via >=.
fn otsu_threshold(gray: &Image, scale: f64) -> Option<f64> {
    let pixels = boosted(gray, scale);
    let mut histogram = [0u64; 256];
    for pixel in &pixels { histogram[*pixel as usize] += 1; }
    let count = pixels.len() as f64;
    if count < 9.0 { return None; }
    let total = histogram.iter().enumerate().map(|(value, &n)| value as f64 * n as f64).sum::<f64>();
    let mut left_count = 0.0;
    let mut left_sum = 0.0;
    let mut best = 0.0;
    let mut means = None;
    for (value, &n) in histogram[..255].iter().enumerate() {
        left_count += n as f64;
        left_sum += value as f64 * n as f64;
        let right_count = count - left_count;
        if left_count < count * 0.005 || right_count < count * 0.005 { continue; }
        let left_mean = left_sum / left_count;
        let right_mean = (total - left_sum) / right_count;
        let variance = left_count * right_count * (right_mean - left_mean).powi(2);
        if variance > best {
            best = variance;
            means = Some((left_mean, right_mean));
        }
    }
    means.filter(|(left, right)| right - left >= 12.0).map(|(left, right)| (left + right) / 2.0)
}

fn polarity_quality(mask: &Image) -> Option<f64> {
    if mask.width < 3 || mask.height < 3 { return None; }
    let mut foreground = 0usize;
    let mut border = 0usize;
    let mut border_ink = 0usize;
    let mut columns = vec![false; mask.width];
    let mut rows = vec![false; mask.height];
    for y in 0..mask.height {
        for x in 0..mask.width {
            let ink = mask.data[y * mask.width + x] != 0;
            if ink { foreground += 1; columns[x] = true; rows[y] = true; }
            if x == 0 || y == 0 || x + 1 == mask.width || y + 1 == mask.height {
                border += 1;
                border_ink += usize::from(ink);
            }
        }
    }
    let ratio = foreground as f64 / mask.data.len() as f64;
    let edge_ratio = border_ink as f64 / border as f64;
    if !(0.005..=0.65).contains(&ratio) || edge_ratio > 0.3 { return None; }
    let column_coverage = columns.iter().filter(|&&ink| ink).count() as f64 / mask.width as f64;
    let row_coverage = rows.iter().filter(|&&ink| ink).count() as f64 / mask.height as f64;
    let structure = (row_coverage.min(column_coverage) * 2.0).min(1.0);
    Some(0.6 * (1.0 - edge_ratio) + 0.25 * (1.0 - (ratio - 0.25).abs() / 0.65) + 0.15 * structure)
}

fn choose_polarity(rgba: &[u8], width: usize, height: usize, candidate: &HudPreprocessSettings) -> HudPreprocessRecommendation {
    let mut light = candidate.clone();
    light.invert = false;
    let mut dark = candidate.clone();
    dark.invert = true;
    let light_score = polarity_quality(&preprocess_hud_rgba(rgba, width, height, &light).1);
    let dark_score = polarity_quality(&preprocess_hud_rgba(rgba, width, height, &dark).1);
    match (light_score, dark_score) {
        (Some(_), None) => HudPreprocessRecommendation::accepted(light),
        (None, Some(_)) => HudPreprocessRecommendation::accepted(dark),
        (Some(a), Some(b)) if a - b >= 0.15 => HudPreprocessRecommendation::accepted(light),
        (Some(a), Some(b)) if b - a >= 0.15 => HudPreprocessRecommendation::accepted(dark),
        _ => HudPreprocessRecommendation::refused("ambiguous-polarity"),
    }
}

pub(crate) fn recommend_hud_roi_preprocess(rgba: &[u8], width: usize, height: usize, settings: &HudPreprocessSettings,
    request: &HudPreprocessRequest) -> Result<HudPreprocessRecommendation, String> {
    settings.validate().map_err(str::to_string)?;
    match request {
        HudPreprocessRequest::Threshold {} => {
            if settings.mode != HudPreprocessMode::Gray { return Err("threshold-requires-gray".into()); }
            let gray = to_grayscale(rgba, width, height);
            let Some(threshold) = otsu_threshold(&gray, settings.scale) else {
                return Ok(HudPreprocessRecommendation::refused("low-contrast"));
            };
            let candidate = HudPreprocessSettings { threshold, ..settings.clone() };
            Ok(choose_polarity(rgba, width, height, &candidate))
        }
        HudPreprocessRequest::Polarity {} => Ok(choose_polarity(rgba, width, height, settings)),
        HudPreprocessRequest::Hsv { x, y } => {
            if *x >= width || *y >= height { return Err("color-point-outside-roi".into()); }
            let pixel = &rgba[(y * width + x) * 4..(y * width + x) * 4 + 4];
            let [hue, saturation, value] = rgb_to_hsv(pixel[0], pixel[1], pixel[2]);
            if value < 0.03 { return Ok(HudPreprocessRecommendation::refused("invalid-color")); }
            let mut candidate = settings.clone();
            candidate.mode = HudPreprocessMode::Hsv;
            candidate.invert = false;
            candidate.hsv = if saturation < 0.04 {
                HudHsvSettings { hue: 0.0, tolerance: 180.0, saturation_min: 0.0, saturation_max: 0.16,
                    value_min: (value - 0.15).max(0.03), value_max: (value + 0.15).min(1.0) }
            } else {
                HudHsvSettings { hue, tolerance: 15.0, saturation_min: (saturation - 0.2).max(0.04),
                    saturation_max: (saturation + 0.2).min(1.0), value_min: (value - 0.25).max(0.03), value_max: (value + 0.25).min(1.0) }
            };
            Ok(HudPreprocessRecommendation::accepted(candidate))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgba(values: &[u8]) -> Vec<u8> {
        values.iter().flat_map(|&value| [value, value, value, 255]).collect()
    }

    #[test]
    fn gray_mode_matches_the_existing_grayscale_baseline_exactly() {
        let pixels: Vec<u8> = (0..256).flat_map(|n| [n as u8, (255 - n) as u8, (n / 2) as u8, 255]).collect();
        for scale in [0.1, 1.0, 1.4, 10.0] {
            for threshold in [0.0, 73.5, 150.0, 255.0] {
                for invert in [false, true] {
                    let internal = PreprocessSettings { scale, threshold, invert };
                    let settings = HudPreprocessSettings::from_internal(&internal);
                    let (gray, binary) = preprocess_hud_rgba(&pixels, 32, 8, &settings);
                    assert_eq!(gray, to_grayscale(&pixels, 32, 8));
                    assert_eq!(binary, binarize(&gray, &internal));
                }
            }
        }
    }

    #[test]
    fn adaptive_integral_windows_match_clipped_reference_and_ignore_flat_backgrounds() {
        let (width, height) = (32, 9);
        let mut values: Vec<u8> = (0..width * height).map(|index| 30 + (index % width) as u8 * 4).collect();
        values[4 * width + 4] += 45;
        values[4 * width + 25] += 45;
        let mut settings = HudPreprocessSettings { mode: HudPreprocessMode::Adaptive, scale: 1.0, ..HudPreprocessSettings::default() };
        settings.adaptive = HudAdaptiveSettings { window_size: 5, offset: 5.0 };
        for invert in [false, true] {
            settings.invert = invert;
            let binary = preprocess_hud_rgba(&rgba(&values), width, height, &settings).1;
            for y in 0usize..height {
                for x in 0usize..width {
                    let neighbors: Vec<_> = (y.saturating_sub(2)..(y + 3).min(height)).flat_map(|yy| {
                        let values = &values;
                        (x.saturating_sub(2)..(x + 3).min(width)).map(move |xx| values[yy * width + xx] as f64)
                    }).collect();
                    let mean = neighbors.iter().sum::<f64>() / neighbors.len() as f64;
                    let selected = if invert { (values[y * width + x] as f64) < mean - 5.0 }
                        else { values[y * width + x] as f64 > mean + 5.0 };
                    assert_eq!(binary.data[y * width + x], if selected { 255 } else { 0 });
                }
            }
            if !invert {
                assert_eq!(binary.data[4 * width + 4], 255);
                assert_eq!(binary.data[4 * width + 25], 255);
                assert_eq!(binary.data[4 * width + 15], 0);
            }
            for offset in [0.0, 7.0] {
                settings.adaptive.offset = offset;
                assert!(preprocess_hud_rgba(&rgba(&vec![130; width * height]), width, height, &settings).1.data.iter().all(|&pixel| pixel == 0));
            }
            settings.adaptive.offset = 5.0;
        }
    }

    #[test]
    fn hsv_separates_equal_luminance_dark_red_blue_and_wraps_red_hue() {
        let pixels = [60, 0, 0, 255, 0, 0, 160, 255, 255, 0, 4, 255, 255, 4, 0, 255];
        let settings = HudPreprocessSettings { mode: HudPreprocessMode::Hsv, ..HudPreprocessSettings::default() };
        let (gray, mask) = preprocess_hud_rgba(&pixels, 4, 1, &settings);
        assert_eq!(gray.data[0], gray.data[1]);
        assert_eq!(mask.data, [255, 0, 255, 255]);
        let mut blue = settings.clone();
        blue.hsv.hue = 240.0;
        assert_eq!(preprocess_hud_rgba(&pixels, 4, 1, &blue).1.data, [0, 255, 0, 0]);
        blue.invert = true;
        assert_eq!(preprocess_hud_rgba(&pixels, 4, 1, &blue).1.data, [255, 0, 255, 255]);
    }

    #[test]
    fn hsv_white_gray_and_black_are_selected_by_saturation_and_value_not_fake_hue() {
        let pixels = [255, 255, 255, 255, 160, 160, 160, 255, 0, 0, 0, 255, 255, 0, 0, 255];
        let mut settings = HudPreprocessSettings { mode: HudPreprocessMode::Hsv, ..HudPreprocessSettings::default() };
        settings.hsv = HudHsvSettings { hue: 240.0, tolerance: 2.0, saturation_min: 0.0, saturation_max: 0.05, value_min: 0.5, value_max: 1.0 };
        assert_eq!(preprocess_hud_rgba(&pixels, 4, 1, &settings).1.data, [255, 255, 0, 0]);
        let recommended = recommend_hud_roi_preprocess(&pixels, 4, 1, &settings, &HudPreprocessRequest::Hsv { x: 0, y: 0 }).unwrap();
        let white = recommended.settings.unwrap();
        assert!(!white.invert);
        assert_eq!(preprocess_hud_rgba(&pixels, 4, 1, &white).1.data, [255, 0, 0, 0]);
        assert_eq!(recommend_hud_roi_preprocess(&pixels, 4, 1, &settings, &HudPreprocessRequest::Hsv { x: 2, y: 0 }).unwrap().reason.as_deref(), Some("invalid-color"));
    }

    fn text_region(invert: bool) -> Vec<u8> {
        let (width, height) = (36, 20);
        let mut pixels = vec![40; width * height];
        for y in 4..16 {
            for x in [7, 8, 15, 16, 23, 24] { pixels[y * width + x] = 210; }
        }
        if invert { for pixel in &mut pixels { *pixel = 250 - *pixel; } }
        rgba(&pixels)
    }

    #[test]
    fn threshold_recommendation_uses_a_cluster_gap_and_correct_background_polarity() {
        let settings = HudPreprocessSettings { scale: 1.0, ..HudPreprocessSettings::default() };
        for invert in [false, true] {
            let pixels = text_region(invert);
            let result = recommend_hud_roi_preprocess(&pixels, 36, 20, &settings, &HudPreprocessRequest::Threshold {}).unwrap();
            let candidate = result.settings.unwrap();
            assert_eq!(candidate.invert, invert);
            assert!(candidate.threshold > 40.0 && candidate.threshold < 210.0);
            let (_, binary) = preprocess_hud_rgba(&pixels, 36, 20, &candidate);
            assert_eq!(binary.data.iter().filter(|&&value| value != 0).count(), 72);
            assert!(result.reason.is_none());
        }
    }

    #[test]
    fn blank_low_contrast_and_ambiguous_polarity_are_not_forced() {
        let settings = HudPreprocessSettings { scale: 1.0, ..HudPreprocessSettings::default() };
        let blank = rgba(&[120; 100]);
        assert_eq!(recommend_hud_roi_preprocess(&blank, 10, 10, &settings, &HudPreprocessRequest::Threshold {}).unwrap().reason.as_deref(), Some("low-contrast"));
        let weak = rgba(&(0..100).map(|i| if i % 10 < 5 { 120 } else { 124 }).collect::<Vec<_>>());
        assert!(recommend_hud_roi_preprocess(&weak, 10, 10, &settings, &HudPreprocessRequest::Threshold {}).unwrap().settings.is_none());
        let halves = rgba(&(0..100).map(|i| if i % 10 < 5 { 30 } else { 230 }).collect::<Vec<_>>());
        for request in [HudPreprocessRequest::Threshold {}, HudPreprocessRequest::Polarity {}] {
            let result = recommend_hud_roi_preprocess(&halves, 10, 10, &settings, &request).unwrap();
            assert!(result.settings.is_none());
            assert_eq!(result.reason.as_deref(), Some("ambiguous-polarity"));
        }
    }

    #[test]
    fn polarity_recommendations_keep_parameters_fixed_and_hsv_uses_original_rgb() {
        let mut settings = HudPreprocessSettings { scale: 1.0, threshold: 100.0, invert: true, ..HudPreprocessSettings::default() };
        let result = recommend_hud_roi_preprocess(&text_region(false), 36, 20, &settings, &HudPreprocessRequest::Polarity {}).unwrap().settings.unwrap();
        settings.invert = false;
        assert_eq!(result, settings);
        let pixels = [255, 0, 4, 255];
        let result = recommend_hud_roi_preprocess(&pixels, 1, 1, &settings, &HudPreprocessRequest::Hsv { x: 0, y: 0 }).unwrap().settings.unwrap();
        assert!(result.hsv.hue > 350.0 && result.hsv.hue < 360.0);
        assert_eq!(result.scale, settings.scale);
        assert_eq!(result.threshold, settings.threshold);
        assert!(recommend_hud_roi_preprocess(&pixels, 1, 1, &result, &HudPreprocessRequest::Threshold {}).is_err());
    }

    #[test]
    fn recommendation_request_objects_are_strict() {
        for raw in [r#"{"kind":"threshold","x":0}"#, r#"{"kind":"polarity","extra":true}"#,
            r#"{"kind":"hsv","x":0}"#, r#"{"kind":"hsv","x":-1,"y":0}"#,
            r#"{"kind":"hsv","x":0.5,"y":0}"#, r#"{"kind":"unknown"}"#] {
            assert!(serde_json::from_str::<HudPreprocessRequest>(raw).is_err(), "{raw}");
        }
        assert!(serde_json::from_str::<HudPreprocessRequest>(r#"{"kind":"hsv","x":0,"y":0}"#).is_ok());
    }
}
