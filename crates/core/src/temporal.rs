use crate::{field_number as n, js_max, js_min, js_round, number, numeric, round_millis as round};
use serde_json::{json, Value};
pub fn parse_countdown(text: &str, format: &str) -> Option<f64> {
    let s = text.trim_matches(crate::js_whitespace);
    let parts: Vec<_> = s.split(':').collect();
    if parts.len() == 2 {
        let a = parts[0];
        let b = parts[1];
        if format == "ss"
            || !(1..=2).contains(&a.len())
            || b.len() != 2
            || !a.bytes().all(|c| c.is_ascii_digit())
            || !b.bytes().all(|c| c.is_ascii_digit())
            || b.as_bytes()[0] > b'5'
            || (format == "m:ss" && a.len() != 1)
            || (format == "mm:ss" && a.len() != 2)
        {
            return None;
        }
        Some(a.parse::<f64>().ok()? * 60.0 + b.parse::<f64>().ok()?)
    } else if (format == "ss" || format == "auto")
        && (1..=2).contains(&s.len())
        && s.bytes().all(|c| c.is_ascii_digit())
    {
        s.parse::<f64>().ok().filter(|&n| n <= 59.0)
    } else {
        None
    }
}
#[derive(Clone)]
struct Candidate {
    text: String,
    seconds: f64,
    count: usize,
    first: Value,
    best: f64,
}
pub struct ClockJumpDetector {
    source: String,
    min_confidence: f64,
    stable_frames: f64,
    range: [f64; 2],
    format: String,
    candidate: Option<Candidate>,
    confirmed: Option<(String, f64)>,
    last: Option<f64>,
}
impl ClockJumpDetector {
    pub fn new(source: &str, options: Value) -> Self {
        Self {
            source: source.into(),
            min_confidence: n(&options, "minConfidence", 0.82),
            stable_frames: js_max(1.0, n(&options, "stableFrames", 2.0)),
            range: [
                options["jumpIntervalRange"]
                    .get(0)
                    .map(number)
                    .unwrap_or(0.4),
                options["jumpIntervalRange"]
                    .get(1)
                    .map(number)
                    .unwrap_or(2.5),
            ],
            format: options["format"].as_str().unwrap_or("auto").into(),
            candidate: None,
            confirmed: None,
            last: None,
        }
    }
    pub fn reset(&mut self) {
        self.candidate = None;
        self.confirmed = None;
        self.last = None;
    }
    pub fn push(&mut self, outcome: Value) -> Value {
        if outcome["status"] != "success" {
            return json!({"event":null});
        }
        let reading = &outcome["reading"];
        let confidence = n(reading, "confidence", f64::NAN);
        if confidence < self.min_confidence {
            return json!({"event":null,"dropped":"low-confidence"});
        }
        let text = reading["text"].as_str().unwrap_or("");
        let Some(seconds) =
            parse_countdown(text, &self.format).filter(|&s| s == number(&reading["seconds"]))
        else {
            return json!({"event":null,"dropped":"unparsable"});
        };
        if let Some(c) = self.candidate.as_mut().filter(|c| c.text == text) {
            c.count += 1;
            c.best = js_max(c.best, confidence);
        } else {
            self.candidate = Some(Candidate {
                text: text.into(),
                seconds,
                count: 1,
                first: reading.clone(),
                best: confidence,
            });
        }
        let c = self.candidate.as_ref().unwrap();
        if (c.count as f64) < self.stable_frames
            || self.confirmed.as_ref().is_some_and(|p| p.0 == c.text)
        {
            return json!({"event":null});
        }
        let prev = self.confirmed.replace((c.text.clone(), c.seconds));
        let Some(prev) = prev else {
            return json!({"event":null});
        };
        if prev.1 - c.seconds != 1.0 {
            self.last = None;
            return json!({"event":null,"dropped":"not-decrement"});
        }
        let mt = number(&c.first["mediaTime"]);
        if let Some(last) = self.last {
            let interval = mt - last;
            if interval < self.range[0] || interval > self.range[1] {
                self.last = Some(mt);
                return json!({"event":null,"dropped":"abnormal-interval"});
            }
        }
        self.last = Some(mt);
        json!({"event":{"source":self.source,"from":prev.0,"to":c.text,"toSeconds":c.seconds,"mediaTime":mt,"wallTime":c.first["wallTime"],"confidence":c.best,"frameIndex":c.first["frameIndex"]}})
    }
}
pub fn clock_anchor_ms(e: &Value) -> f64 {
    number(&e["wallTime"]) + number(&e["toSeconds"]) * 1000.0
}
pub fn median(v: &[f64]) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    let mut a = v.to_vec();
    a.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let m = a.len() >> 1;
    if a.len() % 2 == 1 {
        a[m]
    } else {
        (a[m - 1] + a[m]) / 2.0
    }
}
fn spread(v: &[f64]) -> f64 {
    if v.len() < 2 {
        return 0.0;
    }
    let (mut min, mut max) = (v[0], v[0]);
    for &n in v {
        if n < min {
            min = n;
        }
        if n > max {
            max = n;
        }
    }
    max - min
}
pub fn estimate_offset(official: &[Value], commentary: &[Value], options: &Value) -> Value {
    let reject = |r: &str| json!({"status":"rejected","reason":r});
    if official.is_empty() {
        return reject("no-official-jump");
    }
    if commentary.is_empty() {
        return reject("no-commentary-jump");
    }
    let oa: Vec<_> = official.iter().map(clock_anchor_ms).collect();
    let ca: Vec<_> = commentary.iter().map(clock_anchor_ms).collect();
    let os = spread(&oa) / 1000.0;
    let cs = spread(&ca) / 1000.0;
    let max = n(options, "maxAnchorSpreadSeconds", 0.35);
    if os > max {
        return reject("unstable-official");
    }
    if cs > max {
        return reject("unstable-commentary");
    }
    let conf = official
        .iter()
        .chain(commentary)
        .map(|e| number(&e["confidence"]))
        .fold(f64::INFINITY, js_min);
    if conf < n(options, "minConfidence", 0.82) {
        return reject("low-confidence");
    }
    let residual = (median(&ca) - median(&oa)) / 1000.0;
    let total = n(options, "appliedOffsetSeconds", 0.0) + residual;
    if total.abs() > n(options, "maxOffsetSeconds", 60.0) {
        return reject("out-of-range");
    }
    let aligned = total.abs() <= n(options, "deadbandSeconds", 0.1);
    json!({"status":"ok","residualSeconds":round(residual),"totalOffsetSeconds":round(total),"direction":if aligned{"none"}else if total>0.0{"official"}else{"commentary"},"rewindSeconds":if aligned{0.0}else{round(total.abs())},"confidence":round(conf),"officialAnchorSpread":round(os),"commentaryAnchorSpread":round(cs),"officialEvents":official.len(),"commentaryEvents":commentary.len()})
}
pub fn clamp_offset(offset: f64, max: f64) -> f64 {
    if !offset.is_finite() {
        0.0
    } else {
        js_min(max, js_max(-max, offset))
    }
}
pub fn rewind_for_offset(offset: f64) -> Value {
    json!({"official":numeric(js_max(offset,0.0)),"commentary":numeric(js_max(-offset,0.0))})
}
pub fn offset_from_rewind(rewind: &Value) -> f64 {
    round(number(&rewind["official"]) - number(&rewind["commentary"]))
}
pub fn seekable_range(timebase: &Value) -> Value {
    if timebase["kind"] == "vod" {
        let d = number(&timebase["duration"]);
        json!({"start":0,"end":if d.is_finite(){d.max(0.0)}else{0.0}})
    } else {
        let start = js_max(number(&timebase["seekableStart"]), 0.0);
        let end = js_max(number(&timebase["seekableEnd"]), start);
        json!({"start":numeric(start),"end":numeric(end)})
    }
}
pub fn available_rewind(snapshot: &Value) -> f64 {
    let range = seekable_range(&snapshot["timebase"]);
    js_max(
        number(&snapshot["currentTime"]) - number(&range["start"]),
        0.0,
    )
}
pub fn plan_offset_change(input: &Value) -> Value {
    let epsilon = n(input, "epsilon", 0.001);
    let requested = clamp_offset(number(&input["nextOffset"]), 60.0);
    let desired = rewind_for_offset(requested);
    let mut seeks = vec![];
    let mut after = input["applied"].clone();
    let mut missing = vec![];
    let mut clamped_any = false;
    for role in ["official", "commentary"] {
        let current = number(&input["applied"][role]);
        let target = number(&desired[role]);
        let mov = target - current;
        if mov.abs() < epsilon {
            after[role] = numeric(current);
            continue;
        }
        let snapshot = &input["snapshots"][role];
        if snapshot.is_null() || snapshot["ready"] != true {
            missing.push(role);
            after[role] = json!(0);
            continue;
        }
        let range = seekable_range(&snapshot["timebase"]);
        let time = number(&snapshot["currentTime"]);
        let req = time - mov;
        let to = js_min(number(&range["end"]), js_max(number(&range["start"]), req));
        let clamped = (to - req).abs() > epsilon;
        if clamped {
            clamped_any = true;
        }
        seeks.push(json!({"role":role,"from":numeric(round(time)),"to":numeric(round(to)),"requested":numeric(round(req)),"clamped":clamped,"shortfall":numeric(round((req-to).abs()))}));
        after[role] = numeric(round(js_max(current + (time - to), 0.0)));
    }
    let mut plan = json!({"requestedOffset":round(requested),"effectiveOffset":numeric(offset_from_rewind(&after)),"seeks":seeks,"rewindAfter":after,"limited":clamped_any||!missing.is_empty(),"missingRoles":missing});
    if !missing.is_empty() {
        plan["limitReason"] = json!("not-ready");
    } else if clamped_any {
        plan["limitReason"] = json!("buffer-limit");
    }
    plan
}
pub fn plan_is_complete(plan: &Value, tolerance: f64) -> bool {
    plan["limited"] != true
        && (number(&plan["effectiveOffset"]) - number(&plan["requestedOffset"])).abs() <= tolerance
}
pub fn is_aligned(offset: f64, deadband: f64) -> bool {
    offset.abs() <= deadband
}
pub fn snap_offset(value: f64, step: f64) -> f64 {
    if !value.is_finite() || step <= 0.0 {
        0.0
    } else {
        round(clamp_offset(js_round(value / step) * step, 60.0))
    }
}
pub fn describe_offset(offset: f64, deadband: f64) -> String {
    if is_aligned(offset, deadband) {
        "两路已对齐".into()
    } else {
        format!(
            "让{}后退 {} 秒",
            if offset > 0.0 {
                "官方画面"
            } else {
                "国内解说"
            },
            crate::js_to_fixed(offset.abs(), 2)
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn reading(text: &str, frame: u32) -> Value {
        json!({"status":"success","reading":{"text":text,"seconds":parse_countdown(text,"auto"),"scores":[1],"confidence":0.95,"mediaTime":frame as f64/30.0,"wallTime":frame as f64*(1000.0/30.0),"frameIndex":frame}})
    }
    fn feed(d: &mut ClockJumpDetector, text: &str, start: u32, n: u32) -> Vec<Value> {
        (start..start + n)
            .map(|i| d.push(reading(text, i)))
            .collect()
    }
    #[test]
    fn parse_formats() {
        for (t, f, want) in [
            ("0:45", "auto", Some(45.0)),
            ("00:45", "mm:ss", Some(45.0)),
            ("12:00", "auto", Some(720.0)),
            ("45", "ss", Some(45.0)),
            ("0:45", "mm:ss", None),
            ("0:61", "auto", None),
            ("4:5", "auto", None),
            ("60", "ss", None),
            ("", "auto", None),
        ] {
            assert_eq!(parse_countdown(t, f), want);
        }
    }
    #[test]
    fn jump_first_frame() {
        let mut d = ClockJumpDetector::new("official", json!({"stableFrames":3}));
        feed(&mut d, "01:00", 0, 4);
        let r = feed(&mut d, "00:59", 30, 4);
        assert_eq!(r[2]["event"]["frameIndex"], 30);
        assert_eq!(r[2]["event"]["mediaTime"], 1.0);
        assert!(r[3]["event"].is_null());
    }
    #[test]
    fn reset_skip_and_failure() {
        let mut d = ClockJumpDetector::new("official", json!({}));
        feed(&mut d, "00:46", 0, 3);
        assert_eq!(feed(&mut d, "00:44", 30, 3)[1]["dropped"], "not-decrement");
        assert!(d.push(json!({"status":"failed"}))["event"].is_null());
        d.reset();
        assert!(feed(&mut d, "00:43", 60, 3)
            .iter()
            .all(|v| v["event"].is_null()));
    }
    #[test]
    fn abnormal_interval() {
        let mut d = ClockJumpDetector::new("official", json!({}));
        feed(&mut d, "00:47", 0, 3);
        assert!(feed(&mut d, "00:46", 30, 3)[1]["event"].is_object());
        assert_eq!(
            feed(&mut d, "00:45", 150, 3)[1]["dropped"],
            "abnormal-interval"
        );
    }
    #[test]
    fn median_vectors() {
        assert_eq!(median(&[3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(&[4.0, 1.0, 3.0, 2.0]), 2.5);
        assert!(median(&[]).is_nan());
    }
    #[test]
    fn offset_estimates() {
        let o = vec![json!({"wallTime":10000,"toSeconds":45,"confidence":0.95})];
        let c = vec![json!({"wallTime":15000,"toSeconds":45,"confidence":0.95})];
        assert_eq!(
            estimate_offset(&o, &c, &json!({}))["totalOffsetSeconds"],
            5.0
        );
        assert_eq!(
            estimate_offset(&c, &o, &json!({}))["direction"],
            "commentary"
        );
        assert_eq!(
            estimate_offset(&[], &c, &json!({}))["reason"],
            "no-official-jump"
        );
    }
    #[test]
    fn plan_limits_and_noop() {
        let i = json!({"nextOffset":30,"applied":{"official":0,"commentary":0},"snapshots":{"official":{"ready":true,"currentTime":1000,"timebase":{"kind":"live","seekableStart":990,"seekableEnd":1002}}}});
        let p = plan_offset_change(&i);
        assert_eq!(p["effectiveOffset"], 10.0);
        assert_eq!(p["limitReason"], "buffer-limit");
        assert!(!plan_is_complete(&p, 0.05));
        let mut i = i;
        i["nextOffset"] = json!(0);
        assert_eq!(plan_offset_change(&i)["seeks"], json!([]));
    }
    #[test]
    fn rounding_and_steps() {
        assert_eq!(js_round(-1.5), -1.0);
        assert!(js_round(-0.5).is_sign_negative());
        assert_eq!(snap_offset(3.26, 0.5), 3.5);
        assert_eq!(snap_offset(3.26, 0.05), 3.25);
        assert_eq!(describe_offset(3.42, 0.1), "让官方画面后退 3.42 秒");
        assert_eq!(crate::js_to_fixed(2.55, 1), "2.5");
    }
}
