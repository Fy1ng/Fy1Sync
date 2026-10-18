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
