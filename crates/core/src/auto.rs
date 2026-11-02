//! Pixel-change timing for clocks supplied by manual HUD style packs.
use crate::Image;
use serde::{Deserialize, Serialize};

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

fn valid_image(image: &Image) -> bool {
    image.width > 0
        && image.height > 0
        && image.width.checked_mul(image.height) == Some(image.data.len())
}

#[cfg(test)]
#[path = "auto_tests.rs"]
mod tests;
