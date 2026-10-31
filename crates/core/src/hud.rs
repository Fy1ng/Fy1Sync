use crate::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const HUD_FIELDS: [&str; 3] = ["clock", "scoreLeft", "scoreRight"];
pub const HUD_CUES: [&str; 7] = [
    "replay",
    "bomb",
    "timeout",
    "roundPrefix",
    "roundOver",
    "roundHistory",
    "scoreboard",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HudStylePack {
    pub kind: String,
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub bitmaps: BTreeMap<String, HudBitmap>,
    pub variants: Vec<HudVariant>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HudBitmap {
    pub width: usize,
    pub height: usize,
    pub data: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HudSize {
    pub width: usize,
    pub height: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HudRoi {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
}
impl HudRoi {
    fn rect(&self) -> Rect {
        Rect {
            x: self.x as f64,
            y: self.y as f64,
            width: self.w as f64,
            height: self.h as f64,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HudVariant {
    pub id: String,
    pub native_size: HudSize,
    pub fields: HudFields,
    pub cues: BTreeMap<String, HudCue>,
    pub states: BTreeMap<String, Vec<Vec<HudCondition>>>,
    pub organizer: Option<HudCue>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HudFields {
    pub clock: Option<HudField>,
    pub score_left: Option<HudField>,
    pub score_right: Option<HudField>,
}
impl HudFields {
    fn get(&self, id: &str) -> Option<&HudField> {
        match id {
            "clock" => self.clock.as_ref(),
            "scoreLeft" => self.score_left.as_ref(),
            "scoreRight" => self.score_right.as_ref(),
            _ => None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HudField {
    pub roi: HudRoi,
    pub preprocess: PreprocessSettings,
    pub segment: HudSegment,
    pub glyphs: BTreeMap<String, Vec<String>>,
    pub grammar: HudGrammar,
    pub r#match: HudMatch,
    pub gate_cue: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HudSegment {
    pub min_column_ink: usize,
    pub min_glyph_width: usize,
    pub min_gap_width: usize,
    pub min_ink_ratio: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HudMatch {
    pub min_score: f64,
    pub min_margin: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum HudGrammar {
    Countdown { format: String },
    Integer { min: usize, max: usize },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HudCue {
    pub roi: HudRoi,
    pub preprocess: PreprocessSettings,
    pub templates: Vec<String>,
    pub min_score: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum HudCondition {
    Cue { cue: String, present: bool },
    Field { field: String, present: bool },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HudIssue {
    pub path: String,
    pub message: String,
    pub severity: String,
}

fn problem(issues: &mut Vec<HudIssue>, path: &str, message: &str) {
    issues.push(HudIssue {
        path: path.into(),
        message: message.into(),
        severity: "error".into(),
    });
}
fn path_at(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.into()
    } else {
        format!("{path}.{key}")
    }
}
fn unsigned(v: &Value) -> Option<u64> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n <= 9_007_199_254_740_991.0)
        .map(|n| n as u64)
}
fn object(v: &Value, path: &str, keys: &[&str], issues: &mut Vec<HudIssue>) -> bool {
    let Some(map) = v.as_object() else {
        problem(issues, path, "必须是对象");
        return false;
    };
    for key in map.keys() {
        if !keys.contains(&key.as_str()) {
            problem(issues, &path_at(path, key), "未知字段");
        }
    }
    for key in keys {
        if !map.contains_key(*key) {
            problem(issues, &path_at(path, key), "缺少必填字段");
        }
    }
    true
}
fn bounded(
    v: &Value,
    path: &str,
    lo: f64,
    hi: f64,
    integer: bool,
    issues: &mut Vec<HudIssue>,
) -> Option<f64> {
    match v.as_f64() {
        Some(n) if n.is_finite() && n >= lo && n <= hi && (!integer || n.fract() == 0.0) => Some(n),
        _ => {
            problem(
                issues,
                path,
                if integer {
                    "必须是范围内的整数"
                } else {
                    "必须是范围内的有限数值"
                },
            );
            None
        }
    }
}
fn identifier(v: &Value, path: &str, max: usize, issues: &mut Vec<HudIssue>) {
    let valid = v.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= max
            && !s.contains("..")
            && s.split('/').all(|p| {
                let mut c = p.chars();
                c.next()
                    .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                    && c.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
            })
    });
    if !valid {
        problem(issues, path, "标识无效");
    }
}
fn preprocess(v: &Value, path: &str, issues: &mut Vec<HudIssue>) {
    if !object(v, path, &["scale", "threshold", "invert"], issues) {
        return;
    }
    bounded(
        &v["scale"],
        &path_at(path, "scale"),
        0.1,
        10.0,
        false,
        issues,
    );
    bounded(
        &v["threshold"],
        &path_at(path, "threshold"),
        0.0,
        255.0,
        false,
        issues,
    );
    if !v["invert"].is_boolean() {
        problem(issues, &path_at(path, "invert"), "必须是布尔值");
    }
}
fn roi(v: &Value, size: &Value, path: &str, issues: &mut Vec<HudIssue>) {
    if !object(v, path, &["x", "y", "w", "h"], issues) {
        return;
    }
    let x = bounded(&v["x"], &path_at(path, "x"), 0.0, 16384.0, true, issues);
    let y = bounded(&v["y"], &path_at(path, "y"), 0.0, 16384.0, true, issues);
    let w = bounded(&v["w"], &path_at(path, "w"), 1.0, 16384.0, true, issues);
    let h = bounded(&v["h"], &path_at(path, "h"), 1.0, 16384.0, true, issues);
    if let (Some(x), Some(y), Some(w), Some(h), Some(sw), Some(sh)) =
        (x, y, w, h, size["width"].as_f64(), size["height"].as_f64())
    {
        if x + w > sw || y + h > sh {
            problem(issues, path, "区域超出原生画面");
        }
    }
}
fn references(
    v: &Value,
    bitmaps: &Value,
    path: &str,
    expected: Option<(u64, u64)>,
    allow_empty: bool,
    issues: &mut Vec<HudIssue>,
) {
    let Some(ids) = v.as_array() else {
        problem(issues, path, "必须是位图 ID 数组");
        return;
    };
    if ids.is_empty() && !allow_empty {
        problem(issues, path, "必须是非空位图 ID 数组");
        return;
    }
    for (i, id) in ids.iter().enumerate() {
        let p = format!("{path}[{i}]");
        let Some(id) = id.as_str() else {
            problem(issues, &p, "必须是位图 ID");
            continue;
        };
        let Some(bitmap) = bitmaps.get(id) else {
            problem(issues, &p, "引用的位图不存在");
            continue;
        };
        if let Some((w, h)) = expected {
            if unsigned(&bitmap["width"]) != Some(w) || unsigned(&bitmap["height"]) != Some(h) {
                problem(issues, &p, "位图尺寸与用途不符");
            }
        }
    }
}
fn cue(v: &Value, size: &Value, bitmaps: &Value, path: &str, issues: &mut Vec<HudIssue>) {
    if !object(
        v,
        path,
        &["roi", "preprocess", "templates", "minScore"],
        issues,
    ) {
        return;
    }
    roi(&v["roi"], size, &path_at(path, "roi"), issues);
    preprocess(&v["preprocess"], &path_at(path, "preprocess"), issues);
    bounded(
        &v["minScore"],
        &path_at(path, "minScore"),
        0.0,
        1.0,
        false,
        issues,
    );
    references(
        &v["templates"],
        bitmaps,
        &path_at(path, "templates"),
        unsigned(&v["roi"]["w"]).zip(unsigned(&v["roi"]["h"])),
        true,
        issues,
    );
}
fn field(
    v: &Value,
    name: &str,
    size: &Value,
    bitmaps: &Value,
    path: &str,
    issues: &mut Vec<HudIssue>,
) {
    if v.is_null() {
        return;
    }
    if !object(
        v,
        path,
        &[
            "roi",
            "preprocess",
            "segment",
            "glyphs",
            "grammar",
            "match",
            "gateCue",
        ],
        issues,
    ) {
        return;
    }
    roi(&v["roi"], size, &path_at(path, "roi"), issues);
    preprocess(&v["preprocess"], &path_at(path, "preprocess"), issues);
    let s = &v["segment"];
    let sp = path_at(path, "segment");
    if object(
        s,
        &sp,
        &[
            "minColumnInk",
            "minGlyphWidth",
            "minGapWidth",
            "minInkRatio",
        ],
        issues,
    ) {
        for k in ["minColumnInk", "minGlyphWidth", "minGapWidth"] {
            bounded(&s[k], &path_at(&sp, k), 1.0, 16384.0, true, issues);
        }
        bounded(
            &s["minInkRatio"],
            &path_at(&sp, "minInkRatio"),
            0.0,
            1.0,
            false,
            issues,
        );
    }
    let m = &v["match"];
    let mp = path_at(path, "match");
    if object(m, &mp, &["minScore", "minMargin"], issues) {
        for k in ["minScore", "minMargin"] {
            bounded(&m[k], &path_at(&mp, k), 0.0, 1.0, false, issues);
        }
    }
    let gp = path_at(path, "glyphs");
    if let Some(glyphs) = v["glyphs"].as_object() {
        for (c, ids) in glyphs {
            let cp = path_at(&gp, c);
            if !CLOCK_CHARS.contains(&c.as_str()) || (name != "clock" && c == ":") {
                problem(issues, &cp, "不支持的字形字符");
            }
            references(ids, bitmaps, &cp, Some((32, 48)), false, issues);
        }
    } else {
        problem(issues, &gp, "必须是字形映射对象");
    }
    let g = &v["grammar"];
    let p = path_at(path, "grammar");
    if g["kind"] == "countdown" {
        object(g, &p, &["kind", "format"], issues);
        if !matches!(g["format"].as_str(), Some("m:ss" | "mm:ss" | "ss")) {
            problem(issues, &path_at(&p, "format"), "未知倒计时语法");
        }
        if name != "clock" {
            problem(issues, &path_at(&p, "kind"), "该字段必须使用整数语法");
        }
    } else if g["kind"] == "integer" {
        object(g, &p, &["kind", "min", "max"], issues);
        let min = bounded(
            &g["min"],
            &path_at(&p, "min"),
            0.0,
            99.0,
            true,
            issues,
        );
        let max = bounded(
            &g["max"],
            &path_at(&p, "max"),
            0.0,
            99.0,
            true,
            issues,
        );
        if min.zip(max).is_some_and(|(min, max)| min > max) {
            problem(issues, &p, "最小值不得大于最大值");
        }
        if name == "clock" {
            problem(issues, &path_at(&p, "kind"), "倒计时必须使用倒计时语法");
        }
    } else {
        problem(issues, &path_at(&p, "kind"), "未知字段语法");
    }
    let gate = &v["gateCue"];
    let p = path_at(path, "gateCue");
    if !gate.is_null() {
        problem(issues, &p, "该字段不支持门控");
    }
}

/// Validate before deserializing so unknown keys and semantic errors retain their paths.
pub fn validate_hud_style_pack(value: &Value) -> Vec<HudIssue> {
    let mut issues = Vec::new();
    if unsigned(&value["schemaVersion"]) == Some(2)
        || (value["kind"] != "hud-style-pack"
            && (value.get("templates").is_some() || value.get("clockFormat").is_some()))
    {
        problem(
            &mut issues,
            "schemaVersion",
            "旧 v2 配置已停用, 请重新制作样式包",
        );
        return issues;
    }
    if !object(
        value,
        "",
        &[
            "kind",
            "schemaVersion",
            "id",
            "revision",
            "name",
            "bitmaps",
            "variants",
        ],
        &mut issues,
    ) {
        return issues;
    }
    if value["kind"] != "hud-style-pack" {
        problem(&mut issues, "kind", "必须是 hud-style-pack");
    }
    if unsigned(&value["schemaVersion"]) != Some(1) {
        problem(&mut issues, "schemaVersion", "只支持样式包版本 1");
    }
    identifier(&value["id"], "id", 65, &mut issues);
    bounded(
        &value["revision"],
        "revision",
        1.0,
        9_007_199_254_740_991.0,
        true,
        &mut issues,
    );
    if !value["name"]
        .as_str()
        .is_some_and(|s| !s.trim_matches(crate::js_whitespace).is_empty())
    {
        problem(&mut issues, "name", "名称必须是非空字符串");
    }
    let bitmaps = &value["bitmaps"];
    if let Some(map) = bitmaps.as_object() {
        for (id, b) in map {
            let path = format!("bitmaps.{id}");
            identifier(&json!(id), &path, 128, &mut issues);
            if !object(b, &path, &["width", "height", "data"], &mut issues) {
                continue;
            }
            let w = bounded(
                &b["width"],
                &path_at(&path, "width"),
                1.0,
                16384.0,
                true,
                &mut issues,
            );
            let h = bounded(
                &b["height"],
                &path_at(&path, "height"),
                1.0,
                16384.0,
                true,
                &mut issues,
            );
            let p = path_at(&path, "data");
            if let (Some(w), Some(h), Some(data)) = (w, h, b["data"].as_str()) {
                let count = (w * h) as usize;
                let decoded = if data.len() == count.div_ceil(8).div_ceil(3) * 4 {
                    unpack_bitmap(data, count).ok()
                } else {
                    None
                };
                if let Some(mask) = decoded.filter(|mask| pack_bitmap(mask) == data) {
                    if mask.iter().all(|v| *v == 0) || mask.iter().all(|v| *v != 0) {
                        problem(&mut issues, &p, "位图不能全空或全满");
                    }
                } else {
                    problem(&mut issues, &p, "位图 Base64 格式, 字节数或填充位无效");
                }
            } else if !b["data"].is_string() {
                problem(&mut issues, &p, "位图数据必须是 Base64 字符串");
            }
        }
    } else {
        problem(&mut issues, "bitmaps", "必须是位图映射对象");
    }
    let Some(variants) = value["variants"].as_array() else {
        problem(&mut issues, "variants", "必须是布局数组");
        return issues;
    };
    if variants.is_empty() {
        problem(&mut issues, "variants", "至少需要一个布局");
    }
    let mut ids = BTreeSet::new();
    for (index, v) in variants.iter().enumerate() {
        let p = format!("variants[{index}]");
        if !object(
            v,
            &p,
            &["id", "nativeSize", "fields", "cues", "states", "organizer"],
            &mut issues,
        ) {
            continue;
        }
        identifier(&v["id"], &path_at(&p, "id"), 128, &mut issues);
        if let Some(id) = v["id"].as_str() {
            if !ids.insert(id) {
                problem(&mut issues, &path_at(&p, "id"), "布局 ID 重复");
            }
        }
        let size = &v["nativeSize"];
        let sp = path_at(&p, "nativeSize");
        if object(size, &sp, &["width", "height"], &mut issues) {
            for k in ["width", "height"] {
                bounded(&size[k], &path_at(&sp, k), 1.0, 16384.0, true, &mut issues);
            }
        }
        let cues = &v["cues"];
        let cp = path_at(&p, "cues");
        if let Some(map) = cues.as_object() {
            for (k, c) in map {
                let kp = path_at(&cp, k);
                if !HUD_CUES.contains(&k.as_str()) {
                    problem(&mut issues, &kp, "未知 cue");
                }
                cue(c, size, bitmaps, &kp, &mut issues);
            }
        } else {
            problem(&mut issues, &cp, "必须是 cue 映射对象");
        }
        let fields = &v["fields"];
        let fp = path_at(&p, "fields");
        if object(fields, &fp, &HUD_FIELDS, &mut issues) {
            for k in HUD_FIELDS {
                field(
                    &fields[k],
                    k,
                    size,
                    bitmaps,
                    &path_at(&fp, k),
                    &mut issues,
                );
            }
        }
        if !v["organizer"].is_null() {
            cue(
                &v["organizer"],
                size,
                bitmaps,
                &path_at(&p, "organizer"),
                &mut issues,
            );
        }
        let states = &v["states"];
        let sp = path_at(&p, "states");
        if let Some(map) = states.as_object() {
            for (name, groups) in map {
                let np = path_at(&sp, name);
                identifier(&json!(name), &np, 128, &mut issues);
                let Some(groups) = groups.as_array() else {
                    problem(&mut issues, &np, "必须是条件组数组");
                    continue;
                };
                if groups.is_empty() {
                    problem(&mut issues, &np, "状态条件组不能为空");
                }
                for (i, group) in groups.iter().enumerate() {
                    let gp = format!("{np}[{i}]");
                    let Some(group) = group.as_array() else {
                        problem(&mut issues, &gp, "必须是条件数组");
                        continue;
                    };
                    if group.is_empty() {
                        problem(&mut issues, &gp, "条件组不能为空");
                    }
                    for (j, c) in group.iter().enumerate() {
                        let cp = format!("{gp}[{j}]");
                        if c["kind"] == "cue" {
                            object(c, &cp, &["kind", "cue", "present"], &mut issues);
                            if !c["cue"]
                                .as_str()
                                .is_some_and(|k| HUD_CUES.contains(&k) && cues.get(k).is_some())
                            {
                                problem(&mut issues, &path_at(&cp, "cue"), "引用的 cue 不存在");
                            }
                        } else if c["kind"] == "field" {
                            object(c, &cp, &["kind", "field", "present"], &mut issues);
                            if !c["field"].as_str().is_some_and(|k| {
                                HUD_FIELDS.contains(&k)
                                    && fields.get(k).is_some_and(|v| !v.is_null())
                            }) {
                                problem(&mut issues, &path_at(&cp, "field"), "引用的字段不存在");
                            }
                        } else {
                            problem(&mut issues, &path_at(&cp, "kind"), "未知条件类型");
                            continue;
                        }
                        if !c["present"].is_boolean() {
                            problem(&mut issues, &path_at(&cp, "present"), "必须是布尔值");
                        }
                    }
                }
            }
        } else {
            problem(&mut issues, &sp, "必须是状态映射对象");
        }
    }
    issues
}
pub fn parse_hud_style_pack(value: &Value) -> Result<HudStylePack, Vec<HudIssue>> {
    let issues = validate_hud_style_pack(value);
    if !issues.is_empty() {
        return Err(issues);
    }
    // JSON has one numeric type. Accept integer spellings such as 1.0, as JS does.
    fn integer_spellings(v: &mut Value) {
        if v.is_number() {
            if let Some(n) = unsigned(v) {
                *v = json!(n);
            }
        } else if let Some(map) = v.as_object_mut() {
            for child in map.values_mut() {
                integer_spellings(child);
            }
        } else if let Some(array) = v.as_array_mut() {
            for child in array {
                integer_spellings(child);
            }
        }
    }
    let mut value = value.clone();
    integer_spellings(&mut value);
    serde_json::from_value(value).map_err(|e| {
        vec![HudIssue {
            path: String::new(),
            message: e.to_string(),
            severity: "error".into(),
        }]
    })
}
pub fn hud_pack_from_json(raw: &str) -> Result<HudStylePack, String> {
    let value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    parse_hud_style_pack(&value).map_err(|issues| {
        issues
            .iter()
            .map(|i| format!("{}: {}", i.path, i.message))
            .collect::<Vec<_>>()
            .join("; ")
    })
}
pub fn hud_pack_readiness(pack: &HudStylePack, variant_id: &str) -> Value {
    let Some(field) = pack
        .variants
        .iter()
        .find(|v| v.id == variant_id)
        .and_then(|v| v.fields.clock.as_ref())
    else {
        return json!({"ready":false,"missing":CLOCK_CHARS,"sampleCount":0});
    };
    let needed = &CLOCK_CHARS[..if matches!(&field.grammar,HudGrammar::Countdown{format} if format=="ss")
    {
        10
    } else {
        11
    }];
    let missing: Vec<_> = needed
        .iter()
        .filter(|c| field.glyphs.get(**c).is_none_or(Vec::is_empty))
        .collect();
    json!({"ready":missing.is_empty(),"missing":missing,"sampleCount":field.glyphs.values().map(Vec::len).sum::<usize>()})
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HudDebug {
    pub roi_pixels: Rect,
    pub gray: Image,
    pub binary: Image,
    pub boxes: Vec<GlyphBox>,
    pub projection: Vec<usize>,
    pub ink_ratio: f64,
    pub normalized: Vec<Vec<u8>>,
    pub matches: Vec<GlyphMatch>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HudGlyphPreparation {
    pub roi_pixels: Rect,
    pub gray: Image,
    pub binary: Image,
    pub boxes: Vec<GlyphBox>,
    pub projection: Vec<usize>,
    pub ink_ratio: f64,
    pub normalized: Vec<Vec<u8>>,
    pub bitmaps: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HudReading {
    pub source: String,
    pub text: String,
    pub value: f64,
    pub confidence: f64,
    pub scores: Vec<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum HudFieldResult {
    Read {
        reading: HudReading,
        debug: Option<HudDebug>,
    },
    Absent {
        debug: Option<HudDebug>,
    },
    Indeterminate {
        reason: String,
        debug: Option<HudDebug>,
    },
    Failed {
        reason: String,
        debug: Option<HudDebug>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HudFieldResults {
    pub clock: HudFieldResult,
    pub score_left: HudFieldResult,
    pub score_right: HudFieldResult,
    pub round: HudFieldResult,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HudCueDebug {
    pub roi_pixels: Rect,
    pub gray: Image,
    pub binary: Image,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HudCuePreparation {
    pub roi_pixels: Rect,
    pub gray: Image,
    pub binary: Image,
    pub bitmap: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum HudPresenceResult {
    Matched { score: Option<f64>, debug: Option<HudCueDebug> },
    NotMatched { score: Option<f64>, debug: Option<HudCueDebug> },
    Indeterminate { reason: String, score: Option<f64>, debug: Option<HudCueDebug> },
    Failed { reason: String, score: Option<f64>, debug: Option<HudCueDebug> },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HudFrameResult {
    pub variant_id: String,
    pub fields: HudFieldResults,
    pub cues: BTreeMap<String, HudPresenceResult>,
    pub states: BTreeMap<String, HudPresenceResult>,
    pub organizer: HudPresenceResult,
    pub content: String,
    pub phase: String,
}
fn failed(reason: &str, debug: Option<HudDebug>) -> HudFieldResult {
    HudFieldResult::Failed {
        reason: reason.into(),
        debug,
    }
}
fn frame_variant<'a>(
    rgba: &[u8],
    width: usize,
    height: usize,
    pack: &'a HudStylePack,
    id: &str,
) -> Result<&'a HudVariant, String> {
    let variant = pack
        .variants
        .iter()
        .find(|v| v.id == id)
        .ok_or_else(|| "布局 ID 不存在".to_string())?;
    if width != variant.native_size.width || height != variant.native_size.height {
        return Err("帧尺寸与布局原生尺寸不一致".into());
    }
    if width.checked_mul(height).and_then(|n| n.checked_mul(4)) != Some(rgba.len()) {
        return Err("RGBA 帧数据长度不匹配".into());
    }
    Ok(variant)
}
fn analyze_hud_cue(rgba: &[u8], width: usize, cue: &HudCue) -> HudCueDebug {
    let mut crop = Vec::with_capacity(cue.roi.w * cue.roi.h * 4);
    for y in cue.roi.y..cue.roi.y + cue.roi.h {
        let start = (y * width + cue.roi.x) * 4;
        crop.extend_from_slice(&rgba[start..start + cue.roi.w * 4]);
    }
    let gray = to_grayscale(&crop, cue.roi.w, cue.roi.h);
    let binary = binarize(&gray, &cue.preprocess);
    HudCueDebug { roi_pixels: cue.roi.rect(), gray, binary }
}
pub fn prepare_hud_cue(
    rgba: &[u8],
    width: usize,
    height: usize,
    pack: &HudStylePack,
    id: &str,
    cue_id: &str,
) -> Result<HudCuePreparation, String> {
    let variant = frame_variant(rgba, width, height, pack, id)?;
    let cue = if cue_id == "organizer" { variant.organizer.as_ref() } else { variant.cues.get(cue_id) }
        .ok_or_else(|| "固定图形不存在或尚未配置".to_string())?;
    let debug = analyze_hud_cue(rgba, width, cue);
    Ok(HudCuePreparation {
        bitmap: pack_bitmap(&debug.binary.data),
        roi_pixels: debug.roi_pixels,
        gray: debug.gray,
        binary: debug.binary,
    })
}
fn presence_failed(reason: &str, debug: Option<HudCueDebug>) -> HudPresenceResult {
    HudPresenceResult::Failed { reason: reason.into(), score: None, debug }
}
fn recognize_hud_cue(
    rgba: &[u8],
    width: usize,
    pack: &HudStylePack,
    cue: &HudCue,
) -> HudPresenceResult {
    let debug = analyze_hud_cue(rgba, width, cue);
    if cue.templates.is_empty() {
        return presence_failed("insufficient-templates", Some(debug));
    }
    let score = cue.templates.iter().map(|id| {
        let template = &pack.bitmaps[id];
        let mask = unpack_bitmap(&template.data, template.width * template.height).unwrap();
        score_masks(&debug.binary.data, &mask)
    }).fold(0.0, f64::max);
    if score >= cue.min_score {
        HudPresenceResult::Matched { score: Some(score), debug: Some(debug) }
    } else {
        HudPresenceResult::NotMatched { score: Some(score), debug: Some(debug) }
    }
}
fn presence_matched(result: Option<&HudPresenceResult>) -> bool {
    matches!(result, Some(HudPresenceResult::Matched { .. }))
}
fn condition_value(
    condition: &HudCondition,
    cues: &BTreeMap<String, HudPresenceResult>,
    fields: &HudFieldResults,
) -> Result<Option<bool>, ()> {
    let (value, expected) = match condition {
        HudCondition::Cue { cue, present } => {
            let value = match cues.get(cue) {
                Some(HudPresenceResult::Matched { .. }) => Some(true),
                Some(HudPresenceResult::NotMatched { .. }) => Some(false),
                Some(HudPresenceResult::Indeterminate { .. }) => None,
                _ => return Err(()),
            };
            (value, *present)
        }
        HudCondition::Field { field, present } => {
            let field = match field.as_str() {
                "clock" => &fields.clock,
                "scoreLeft" => &fields.score_left,
                "scoreRight" => &fields.score_right,
                _ => return Err(()),
            };
            let value = match field {
                HudFieldResult::Read { .. } => Some(true),
                HudFieldResult::Absent { .. } => Some(false),
                HudFieldResult::Indeterminate { .. } => None,
                HudFieldResult::Failed { .. } => return Err(()),
            };
            (value, *present)
        }
    };
    Ok(value.map(|value| value == expected))
}
fn evaluate_hud_state(
    groups: &[Vec<HudCondition>],
    cues: &BTreeMap<String, HudPresenceResult>,
    fields: &HudFieldResults,
) -> HudPresenceResult {
    let mut matched = false;
    let mut uncertain = false;
    for group in groups {
        let mut group_matches = true;
        let mut group_uncertain = false;
        for condition in group {
            match condition_value(condition, cues, fields) {
                Err(()) => return presence_failed("dependency-failed", None),
                Ok(Some(false)) => group_matches = false,
                Ok(Some(true)) => (),
                Ok(None) => group_uncertain = true,
            }
        }
        matched |= group_matches && !group_uncertain;
        uncertain |= group_matches && group_uncertain;
    }
    if matched {
        HudPresenceResult::Matched { score: None, debug: None }
    } else if uncertain {
        HudPresenceResult::Indeterminate { reason: "dependency-indeterminate".into(), score: None, debug: None }
    } else {
        HudPresenceResult::NotMatched { score: None, debug: None }
    }
}
/// Replay or live. A pack that configures neither a replay state nor a replay cue cannot see
/// a marker, so it never sees one: live, as for any frame without a marker (cold start A).
/// Configured but unreadable stays indeterminate.
fn hud_content(cues: &BTreeMap<String, HudPresenceResult>, states: &BTreeMap<String, HudPresenceResult>) -> String {
    match states.get("replay").or_else(|| cues.get("replay")) {
        None => "live",
        Some(HudPresenceResult::Matched { .. }) => "replay",
        Some(HudPresenceResult::NotMatched { .. }) => "live",
        _ => "indeterminate",
    }.into()
}
/// The phase of play. With no `active` state configured, a frame that matches no phase is
/// unconfigured rather than indeterminate: the pack does not judge phases, so it must not
/// hold the clock back. A configured phase that fails to read still makes it indeterminate.
fn hud_phase(states: &BTreeMap<String, HudPresenceResult>) -> String {
    if ["statistics", "round-history", "scoreboard"].iter().any(|id| presence_matched(states.get(*id))) {
        return "statistics".into();
    }
    let mut phase = None;
    for (id, value) in [
        ("statistics", "statistics"), ("round-history", "statistics"), ("scoreboard", "statistics"),
        ("paused", "paused"), ("round-over", "roundOver"), ("planted", "planted"), ("active", "active"),
    ] {
        match states.get(id) {
            Some(HudPresenceResult::Matched { .. }) => {
                if phase.is_some_and(|current| current != value) {
                    return "indeterminate".into();
                }
                phase = Some(value);
            }
            Some(HudPresenceResult::Failed { .. } | HudPresenceResult::Indeterminate { .. }) => {
                return "indeterminate".into();
            }
            _ => (),
        }
    }
    phase.unwrap_or(if states.contains_key("active") { "indeterminate" } else { "unconfigured" }).into()
}
fn analyze_hud_field(rgba: &[u8], width: usize, field: &HudField) -> (HudDebug, Vec<Vec<u8>>) {
    let rect = field.roi.rect();
    let mut crop = Vec::with_capacity(field.roi.w * field.roi.h * 4);
    for y in field.roi.y..field.roi.y + field.roi.h {
        let start = (y * width + field.roi.x) * 4;
        crop.extend_from_slice(&rgba[start..start + field.roi.w * 4]);
    }
    let gray = to_grayscale(&crop, field.roi.w, field.roi.h);
    let binary = binarize(&gray, &field.preprocess);
    let seg = segment_glyphs(&binary, &serde_json::to_value(&field.segment).unwrap());
    let coverage: Vec<_> = seg
        .boxes
        .iter()
        .map(|b| normalize_glyph_coverage(&crop_binary(&binary, &b.rect())))
        .collect();
    let normalized = coverage.iter().map(|c| threshold_coverage(c)).collect();
    (
        HudDebug {
            roi_pixels: rect,
            gray,
            ink_ratio: ink_ratio(&binary),
            binary,
            boxes: seg.boxes,
            projection: seg.projection,
            normalized,
            matches: vec![],
        },
        coverage,
    )
}
pub fn prepare_hud_glyphs(
    rgba: &[u8],
    width: usize,
    height: usize,
    pack: &HudStylePack,
    id: &str,
    field_id: &str,
) -> Result<HudGlyphPreparation, String> {
    prepare_hud_glyphs_with_boxes(rgba, width, height, pack, id, field_id, None)
}
pub fn prepare_hud_glyphs_with_boxes(
    rgba: &[u8],
    width: usize,
    height: usize,
    pack: &HudStylePack,
    id: &str,
    field_id: &str,
    boxes: Option<Vec<GlyphBox>>,
) -> Result<HudGlyphPreparation, String> {
    let variant = frame_variant(rgba, width, height, pack, id)?;
    let field = variant
        .fields
        .get(field_id)
        .ok_or_else(|| "字段不存在或尚未配置".to_string())?;
    let (mut debug, _) = analyze_hud_field(rgba, width, field);
    if let Some(boxes) = boxes {
        for b in &boxes {
            if [b.x, b.y, b.width, b.height]
                .iter()
                .any(|v| !v.is_finite() || v.fract() != 0.0)
                || b.x < 0.0
                || b.y < 0.0
                || b.width < 1.0
                || b.height < 1.0
                || b.x + b.width > debug.binary.width as f64
                || b.y + b.height > debug.binary.height as f64
            {
                return Err("字框必须是二值区域内的整数矩形".into());
            }
        }
        debug.normalized = boxes
            .iter()
            .map(|b| normalize_glyph(&crop_binary(&debug.binary, &b.rect())))
            .collect();
        debug.boxes = boxes;
    }
    let bitmaps = debug
        .normalized
        .iter()
        .map(|mask| pack_bitmap(mask))
        .collect();
    Ok(HudGlyphPreparation {
        roi_pixels: debug.roi_pixels,
        gray: debug.gray,
        binary: debug.binary,
        boxes: debug.boxes,
        projection: debug.projection,
        ink_ratio: debug.ink_ratio,
        normalized: debug.normalized,
        bitmaps,
    })
}
fn parse_score(text: &str, min: usize, max: usize) -> Option<f64> {
    if text.is_empty() || text.len() > 2 || !text.bytes().all(|c| c.is_ascii_digit())
        || (text.len() > 1 && text.starts_with('0')) {
        return None;
    }
    let value = text.parse::<usize>().ok()?;
    (value <= 99 && value >= min && value <= max).then_some(value as f64)
}
fn recognize_hud_field(
    rgba: &[u8],
    width: usize,
    pack: &HudStylePack,
    id: &str,
    field: Option<&HudField>,
) -> HudFieldResult {
    if let Some(field) = field {
        let (mut debug, coverage) = analyze_hud_field(rgba, width, field);
        let mut templates = CompiledTemplates {
            chars: vec![],
            masks: vec![],
        };
        for c in CLOCK_CHARS {
            if let Some(ids) = field.glyphs.get(c) {
                let masks = ids
                    .iter()
                    .filter_map(|id| pack.bitmaps.get(id))
                    .map(|b| unpack_bitmap(&b.data, 1536).unwrap())
                    .collect::<Vec<_>>();
                if !masks.is_empty() {
                    templates.chars.push(c.into());
                    templates.masks.push((c.into(), masks));
                }
            }
        }
        debug.matches = coverage
            .iter()
            .map(|mask| match_glyph(mask, &templates))
            .collect();
        let countdown = matches!(field.grammar, HudGrammar::Countdown { .. });
        let complete = CLOCK_CHARS[..10].iter().all(|c| field.glyphs.get(*c).is_some_and(|ids| !ids.is_empty()));
        if countdown && hud_pack_readiness(pack, id)["ready"] != true {
            failed("insufficient-templates", Some(debug))
        } else if debug.ink_ratio < 0.004 || debug.ink_ratio > 0.85 {
            failed("blank-frame", Some(debug))
        } else if debug.boxes.is_empty() {
            failed("no-candidates", Some(debug))
        } else if debug.matches.iter().any(|m| m.char.is_none() || m.score < field.r#match.min_score) {
            failed(if !countdown && !complete { "missing-glyph" } else { "low-confidence" }, Some(debug))
        } else if debug.matches.iter().any(|m| m.score - m.runner_up_score < field.r#match.min_margin) {
            failed("low-confidence", Some(debug))
        } else {
            let text: String = debug
                .matches
                .iter()
                .filter_map(|m| m.char.as_deref())
                .collect();
            let value = match &field.grammar {
                HudGrammar::Countdown { format } => parse_countdown(&text, format),
                HudGrammar::Integer { min, max } => parse_score(&text, *min, *max),
            };
            if let Some(value) = value {
                let scores: Vec<_> = debug.matches.iter().map(|m| m.score).collect();
                let confidence = scores.iter().copied().fold(1.0, f64::min);
                HudFieldResult::Read {
                    reading: HudReading {
                        source: "recognized".into(),
                        text,
                        value,
                        confidence,
                        scores,
                    },
                    debug: Some(debug),
                }
            } else {
                failed("invalid-format", Some(debug))
            }
        }
    } else {
        failed("not-configured", None)
    }
}
fn derive_round(left: &HudFieldResult, right: &HudFieldResult) -> HudFieldResult {
    match (left, right) {
        (HudFieldResult::Read { reading: left, .. }, HudFieldResult::Read { reading: right, .. }) => {
            let value = left.value + right.value + 1.0;
            HudFieldResult::Read {
                reading: HudReading {
                    source: "derived".into(),
                    text: format!("{value:.0}"),
                    value,
                    confidence: left.confidence.min(right.confidence),
                    scores: left.scores.iter().chain(&right.scores).copied().collect(),
                },
                debug: None,
            }
        }
        (HudFieldResult::Failed { .. }, _) | (_, HudFieldResult::Failed { .. }) => {
            failed("score-failed", None)
        }
        _ => HudFieldResult::Indeterminate { reason: "score-indeterminate".into(), debug: None },
    }
}
pub fn recognize_hud_frame(
    rgba: &[u8],
    width: usize,
    height: usize,
    pack: &HudStylePack,
    id: &str,
) -> Result<HudFrameResult, String> {
    let variant = frame_variant(rgba, width, height, pack, id)?;
    let cues: BTreeMap<_, _> = variant.cues.iter().map(|(key, cue)| {
        (key.clone(), recognize_hud_cue(rgba, width, pack, cue))
    }).collect();
    let statistics = ["roundHistory", "scoreboard"].iter().any(|id| presence_matched(cues.get(*id)));
    let planted = presence_matched(cues.get("bomb"));
    let read_field = |field: Option<&HudField>, absent: bool| {
        if absent && field.is_some() {
            HudFieldResult::Absent { debug: None }
        } else {
            recognize_hud_field(rgba, width, pack, id, field)
        }
    };
    let clock = read_field(variant.fields.clock.as_ref(), statistics || planted);
    let score_left = read_field(variant.fields.score_left.as_ref(), statistics);
    let score_right = read_field(variant.fields.score_right.as_ref(), statistics);
    let round = derive_round(&score_left, &score_right);
    let fields = HudFieldResults { clock, score_left, score_right, round };
    let states = variant.states.iter().map(|(key, groups)| {
        (key.clone(), evaluate_hud_state(groups, &cues, &fields))
    }).collect();
    let content = hud_content(&cues, &states);
    let phase = hud_phase(&states);
    let organizer = variant.organizer.as_ref().map_or_else(
        || presence_failed("not-configured", None),
        |cue| recognize_hud_cue(rgba, width, pack, cue),
    );
    Ok(HudFrameResult {
        variant_id: id.into(),
        fields,
        cues,
        states,
        organizer,
        content,
        phase,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn presence(value: Option<bool>) -> HudPresenceResult {
        match value {
            Some(true) => HudPresenceResult::Matched { score: None, debug: None },
            Some(false) => HudPresenceResult::NotMatched { score: None, debug: None },
            None => presence_failed("insufficient-templates", None),
        }
    }
    fn cue_condition(cue: &str, present: bool) -> HudCondition {
        HudCondition::Cue { cue: cue.into(), present }
    }
    fn state_fields(clock: HudFieldResult) -> HudFieldResults {
        HudFieldResults { clock, score_left: failed("not-configured", None), score_right: failed("not-configured", None), round: failed("score-failed", None) }
    }

    #[test]
    fn state_rules_use_or_of_and_and_fail_on_any_failed_dependency() {
        let fields = state_fields(HudFieldResult::Absent { debug: None });
        let cues = BTreeMap::from([
            ("replay".into(), presence(Some(true))),
            ("bomb".into(), presence(Some(false))),
            ("timeout".into(), presence(None)),
        ]);
        let groups = vec![
            vec![cue_condition("replay", true), cue_condition("bomb", false)],
            vec![cue_condition("bomb", true)],
        ];
        assert!(matches!(evaluate_hud_state(&groups, &cues, &fields), HudPresenceResult::Matched { .. }));
        let groups = vec![vec![cue_condition("replay", false)], vec![cue_condition("bomb", true)]];
        assert!(matches!(evaluate_hud_state(&groups, &cues, &fields), HudPresenceResult::NotMatched { .. }));
        for groups in [
            vec![vec![cue_condition("replay", true)], vec![cue_condition("timeout", false)]],
            vec![vec![cue_condition("bomb", true), cue_condition("timeout", true)]],
            vec![vec![HudCondition::Field { field: "scoreLeft".into(), present: false }]],
        ] {
            assert!(matches!(evaluate_hud_state(&groups, &cues, &fields), HudPresenceResult::Failed { .. }));
        }
        let no_clock = vec![vec![HudCondition::Field { field: "clock".into(), present: false }]];
        assert!(matches!(evaluate_hud_state(&no_clock, &cues, &fields), HudPresenceResult::Matched { .. }));
        let unknown_fields = state_fields(HudFieldResult::Indeterminate { reason: "unknown".into(), debug: None });
        assert!(matches!(evaluate_hud_state(&no_clock, &cues, &unknown_fields), HudPresenceResult::Indeterminate { .. }));
        let false_and_unknown = vec![vec![cue_condition("bomb", true), HudCondition::Field { field: "clock".into(), present: false }]];
        assert!(matches!(evaluate_hud_state(&false_and_unknown, &cues, &unknown_fields), HudPresenceResult::NotMatched { .. }));
    }

    #[test]
    fn content_and_phase_are_independent_and_statistics_takes_precedence() {
        let cues = BTreeMap::from([("replay".into(), presence(Some(true)))]);
        let mut states = BTreeMap::from([("planted".into(), presence(Some(true)))]);
        assert_eq!(hud_content(&cues, &states), "replay");
        assert_eq!(hud_phase(&states), "planted");
        states.insert("paused".into(), presence(Some(true)));
        assert_eq!(hud_phase(&states), "indeterminate");
        states.insert("round-history".into(), presence(Some(true)));
        states.insert("scoreboard".into(), presence(Some(true)));
        assert_eq!(hud_phase(&states), "statistics");
        states.clear();
        states.insert("round-over".into(), presence(Some(true)));
        assert_eq!(hud_phase(&states), "roundOver");
        states.insert("planted".into(), presence(None));
        assert_eq!(hud_phase(&states), "indeterminate");
        states.clear();
        assert_eq!(hud_phase(&states), "unconfigured");
        assert_eq!(hud_content(&BTreeMap::new(), &states), "live");
        states.insert("replay".into(), presence(Some(false)));
        assert_eq!(hud_content(&cues, &states), "live");
    }

    #[test]
    fn an_unconfigured_axis_does_not_hold_the_clock_back() {
        // No replay state or cue: live, as cold start A treats any frame without a marker.
        assert_eq!(hud_content(&BTreeMap::new(), &BTreeMap::new()), "live");
        // A replay cue that cannot be read is not the same as no cue.
        let unreadable = BTreeMap::from([("replay".into(), presence(None))]);
        assert_eq!(hud_content(&unreadable, &BTreeMap::new()), "indeterminate");
        // Phases configured, but not active play: a frame matching none of them is unjudged.
        let only_planted = BTreeMap::from([("planted".into(), presence(Some(false)))]);
        assert_eq!(hud_phase(&only_planted), "unconfigured");
        // Active play configured and not seen: indeterminate, as before.
        let with_active = BTreeMap::from([("planted".into(), presence(Some(false))), ("active".into(), presence(Some(false)))]);
        assert_eq!(hud_phase(&with_active), "indeterminate");
        // A configured phase that fails to read still blocks, active or not.
        let failing = BTreeMap::from([("paused".into(), presence(None))]);
        assert_eq!(hud_phase(&failing), "indeterminate");
        // Matched phases are reported whether or not active is configured.
        let planted = BTreeMap::from([("planted".into(), presence(Some(true)))]);
        assert_eq!(hud_phase(&planted), "planted");
    }

    #[test]
    fn derived_round_propagates_the_worse_score_status() {
        let read = HudFieldResult::Read {
            reading: HudReading { source: "recognized".into(), text: "99".into(), value: 99.0, confidence: 0.9, scores: vec![0.9, 0.95] },
            debug: None,
        };
        let absent = HudFieldResult::Absent { debug: None };
        let unknown = HudFieldResult::Indeterminate { reason: "unknown-state".into(), debug: None };
        let failure = failed("missing-glyph", None);
        for (left, right) in [(&read, &unknown), (&unknown, &read), (&unknown, &unknown), (&read, &absent), (&absent, &read)] {
            assert!(matches!(derive_round(left, right), HudFieldResult::Indeterminate { .. }));
        }
        for (left, right) in [(&failure, &unknown), (&unknown, &failure), (&failure, &read), (&read, &failure), (&failure, &failure), (&absent, &failure)] {
            assert!(matches!(derive_round(left, right), HudFieldResult::Failed { .. }));
        }
        let HudFieldResult::Read { reading, .. } = derive_round(&read, &read) else { unreachable!() };
        assert_eq!(reading.value, 199.0);
        assert_eq!(reading.source, "derived");
        assert_eq!(reading.confidence, 0.9);
    }
}
