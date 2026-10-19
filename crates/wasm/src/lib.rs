#![forbid(unsafe_code)]
//! Thin JSON/byte-array bridge; all algorithms live in stream-syncer-core.
use stream_syncer_core::Engine;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct RecognitionEngine {
    inner: Engine,
}
#[wasm_bindgen]
impl RecognitionEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Engine::new(),
        }
    }
    pub fn configure(&mut self, profile_json: &str) -> Result<String, JsValue> {
        self.inner
            .configure(profile_json)
            .map(|v| v.to_string())
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn recognize(
        &self,
        rgba: &[u8],
        width: usize,
        height: usize,
        media_time: f64,
        wall_time: f64,
        frame_index: f64,
        want_debug: bool,
    ) -> String {
        self.inner
            .recognize(
                rgba,
                width,
                height,
                media_time,
                wall_time,
                frame_index,
                want_debug,
            )
            .to_string()
    }
}
impl Default for RecognitionEngine {
    fn default() -> Self {
        Self::new()
    }
}
#[wasm_bindgen]
pub fn dispatch(op: &str, input_json: &str) -> Result<String, JsValue> {
    let input = serde_json::from_str(input_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    stream_syncer_core::dispatch(op, input)
        .map(|v| v.to_string())
        .map_err(|e| JsValue::from_str(&e))
}
#[wasm_bindgen]
pub struct ClockJumpDetector {
    inner: stream_syncer_core::ClockJumpDetector,
}
#[wasm_bindgen]
impl ClockJumpDetector {
    #[wasm_bindgen(constructor)]
    pub fn new(source: &str, options_json: &str) -> Result<ClockJumpDetector, JsValue> {
        let options =
            serde_json::from_str(options_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Self {
            inner: stream_syncer_core::ClockJumpDetector::new(source, options),
        })
    }
    pub fn reset(&mut self) {
        self.inner.reset();
    }
    pub fn push(&mut self, outcome_json: &str) -> Result<String, JsValue> {
        let outcome =
            serde_json::from_str(outcome_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(self.inner.push(outcome).to_string())
    }
}

/// Bounded, source-local discovery window. Pixels are grayscale, one byte per pixel.
/// This API is available to workers without changing the P3 worker protocol or UI.
#[wasm_bindgen]
pub struct AutoClockSession {
    frames: Vec<stream_syncer_core::TimedFrame>,
    bytes: usize,
}

fn gray_image(
    pixels: &[u8],
    width: usize,
    height: usize,
) -> Result<stream_syncer_core::Image, JsValue> {
    let count = width
        .checked_mul(height)
        .filter(|&n| n > 0 && n <= 16_777_216)
        .ok_or_else(|| JsValue::from_str("帧尺寸无效"))?;
    if pixels.len() != count {
        return Err(JsValue::from_str("灰度帧数据长度不匹配"));
    }
    Ok(stream_syncer_core::Image {
        data: pixels.to_vec(),
        width,
        height,
    })
}

/// Explicit P4a partial-profile path; the existing recognition engine stays unchanged.
#[wasm_bindgen]
pub fn recognize_auto(
    pixels: &[u8],
    width: usize,
    height: usize,
    profile_json: &str,
) -> Result<String, JsValue> {
    let image = gray_image(pixels, width, height)?;
    let profile: stream_syncer_core::RecognitionProfile = serde_json::from_str(profile_json)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_json::to_string(&stream_syncer_core::recognize_auto_frame(&image, &profile))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
impl AutoClockSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            frames: Vec::new(),
            bytes: 0,
        }
    }
    pub fn reset(&mut self) {
        self.frames.clear();
        self.bytes = 0;
    }
    pub fn push(
        &mut self,
        pixels: &[u8],
        width: usize,
        height: usize,
        time: f64,
    ) -> Result<(), JsValue> {
        if !time.is_finite() || self.frames.last().is_some_and(|f| time <= f.time) {
            return Err(JsValue::from_str("时间戳必须有限且严格递增"));
        }
        if self.frames.len() >= 600 || self.bytes.saturating_add(pixels.len()) > 128 * 1024 * 1024 {
            return Err(JsValue::from_str(
                "自动学习窗口达到内存上限, 请重置或降低分辨率/采样率",
            ));
        }
        if self
            .frames
            .first()
            .is_some_and(|f| f.image.width != width || f.image.height != height)
        {
            return Err(JsValue::from_str("窗口内帧尺寸必须一致"));
        }
        let image = gray_image(pixels, width, height)?;
        self.bytes += image.data.len();
        self.frames
            .push(stream_syncer_core::TimedFrame { time, image });
        Ok(())
    }
    pub fn locate(&self) -> String {
        serde_json::to_string(&stream_syncer_core::locate_clock(&self.frames)).unwrap()
    }
    pub fn learn(&self, roi_json: &str) -> Result<String, JsValue> {
        let roi: stream_syncer_core::RoiRect =
            serde_json::from_str(roi_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        if ![roi.x, roi.y, roi.w, roi.h].iter().all(|v| v.is_finite())
            || roi.x < 0.0
            || roi.y < 0.0
            || roi.w <= 0.0
            || roi.h <= 0.0
            || roi.x + roi.w > 1.0
            || roi.y + roi.h > 1.0
        {
            return Err(JsValue::from_str("ROI 必须位于画面内且宽高为正"));
        }
        serde_json::to_string(&stream_syncer_core::learn_clock(&self.frames, &roi))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}
impl Default for AutoClockSession {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
pub struct TickMomentDetector {
    inner: stream_syncer_core::TickMomentDetector,
    last_time: Option<f64>,
}
#[wasm_bindgen]
impl TickMomentDetector {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: stream_syncer_core::TickMomentDetector::new(),
            last_time: None,
        }
    }
    pub fn reset(&mut self) {
        self.inner.reset();
        self.last_time = None;
    }
    pub fn push(
        &mut self,
        pixels: &[u8],
        width: usize,
        height: usize,
        time: f64,
    ) -> Result<String, JsValue> {
        if !time.is_finite() || self.last_time.is_some_and(|last| time <= last) {
            return Err(JsValue::from_str("时间戳必须有限且严格递增"));
        }
        let image = gray_image(pixels, width, height)?;
        self.last_time = Some(time);
        serde_json::to_string(&self.inner.push(&image, time))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}
impl Default for TickMomentDetector {
    fn default() -> Self {
        Self::new()
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn engine_configure_json() {
        let mut engine = super::RecognitionEngine::new();
        let p = stream_syncer_core::empty_profile("custom/test", "Test");
        let ready = engine.configure(&p.to_string()).unwrap();
        assert!(ready.contains("missing"));
        let result = engine.recognize(&[0; 4], 1, 1, 0.0, 0.0, 0.0, false);
        assert!(result.contains("insufficient-templates"));
    }
    #[test]
    fn dispatch_json() {
        assert_eq!(
            super::dispatch("parseCountdown", "[\"1:05\"]").unwrap(),
            "65.0"
        );
    }
}
