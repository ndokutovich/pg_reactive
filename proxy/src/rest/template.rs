//! `{{opId.field}}` template resolution for batch operations.
//!
//! Mirrors the Go proxy's `rest/template.go`: a `{{ ... }}` reference is
//! replaced with a value navigated out of a previous operation's result by a
//! dot-path (`op.field`, `op.0.id`, `op.*.id`). The match grammar is the Go
//! regex `\{\{([^}]+)\}\}` (a non-empty run of non-`}` characters between the
//! braces); an unresolvable reference makes the whole resolution fail so the
//! owning operation fails immediately.

use std::collections::HashMap;

use serde_json::Value;

use crate::error::AppError;

/// Replace every `{{opId.field}}` reference in a raw JSON string with the value
/// extracted from a previous operation's result. Returns the resolved JSON.
///
/// A string without `{{` (including the empty string) is returned unchanged,
/// matching the Go fast-path.
pub fn resolve_templates(
    raw: &str,
    results: &HashMap<String, Value>,
) -> Result<String, AppError> {
    if !raw.contains("{{") {
        return Ok(raw.to_string());
    }
    // JSON-body path: render leaves with `json_string_escape` so a string value
    // cannot break out of its `"{{x}}"` literal and inject structure (round-45
    // F1). The top-level transform is identity — escaping happens at the leaf.
    replace_templates(raw, results, json_string_escape, |v| v)
}

/// Replace `{{opId.field}}` references in a plain string (e.g. a query string).
///
/// Individual resolved values are URL-encoded before substitution to prevent
/// injection of additional query parameters via characters like `&` or `=`.
/// Wildcard expansions (`{{op.*.id}}`) encode each comma-separated element
/// separately so the structural commas between elements are preserved.
pub fn resolve_templates_in_string(
    s: &str,
    results: &HashMap<String, Value>,
) -> Result<String, AppError> {
    if !s.contains("{{") {
        return Ok(s.to_string());
    }
    // Query-string path: leaf is the raw `unquote_json` content; the top-level
    // transform URL-encodes it (preserving structural commas), so the unescaped
    // content is safe here.
    replace_templates(s, results, unquote_json, url_encode_preserving_commas)
}

/// Core scanner. Walks `s`, finds each `{{ <non-`}`+> }}` match left-to-right,
/// and substitutes `transform(resolved_value)`. All resolution errors are
/// collected; if any occurred the whole call fails (mirrors Go, which joins the
/// error messages with `; `).
fn replace_templates<F>(
    s: &str,
    results: &HashMap<String, Value>,
    leaf: fn(&Value) -> String,
    transform: F,
) -> Result<String, AppError>
where
    F: Fn(String) -> String,
{
    let mut out = String::with_capacity(s.len());
    let mut errors: Vec<String> = Vec::new();
    let mut i = 0;

    while i < s.len() {
        if s[i..].starts_with("{{") {
            // `[^}]+` — find the first '}' after the opening braces.
            if let Some(rel) = s[i + 2..].find('}') {
                let close = i + 2 + rel; // index of the first '}'
                let inner = &s[i + 2..close];
                if !inner.is_empty() && s[close..].starts_with("}}") {
                    match resolve_expression(inner, results, leaf) {
                        Ok(v) => out.push_str(&transform(v)),
                        Err(e) => {
                            errors.push(e);
                            // Leave the original token in place (as Go does).
                            out.push_str(&s[i..close + 2]);
                        }
                    }
                    i = close + 2;
                    continue;
                }
            }
            // Not a valid template token: emit one char and advance.
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }

    if !errors.is_empty() {
        return Err(AppError::BadRequest(format!(
            "template resolution errors: {}",
            errors.join("; ")
        )));
    }
    Ok(out)
}

/// URL-encode each comma-separated segment individually so structural commas
/// (from wildcard expansions) survive while `&`/`=` in values are escaped.
fn url_encode_preserving_commas(s: String) -> String {
    s.split(',')
        .map(|p| urlencoding::encode(p).into_owned())
        .collect::<Vec<_>>()
        .join(",")
}

/// Navigate a dot-path like `op1.id` or `op1.0.name` into the results map and
/// return the string representation of the value.
fn resolve_expression(
    expr: &str,
    results: &HashMap<String, Value>,
    leaf: fn(&Value) -> String,
) -> Result<String, String> {
    let (op_id, rest) = match expr.split_once('.') {
        Some((op, rest)) => (op, Some(rest)),
        None => (expr, None),
    };

    let data = results
        .get(op_id)
        .ok_or_else(|| format!("template: operation {op_id:?} not found"))?;

    match rest {
        None => Ok(leaf(data)),
        Some(path) => navigate_path(data, path, leaf),
    }
}

/// Traverse a dot-separated path into a JSON value.
/// Supports: `field`, `N` (array index), `N.field`, and `*` (wildcard over an
/// array, collecting the remaining path from every element).
fn navigate_path(data: &Value, path: &str, leaf: fn(&Value) -> String) -> Result<String, String> {
    let segments: Vec<&str> = path.split('.').collect();
    let mut current = data;

    for (i, seg) in segments.iter().enumerate() {
        if current.is_null() {
            return Err(format!("template: cannot navigate into null at {seg:?}"));
        }

        // Wildcard: collect a field from every element of an array.
        if *seg == "*" {
            let arr = current.as_array().ok_or_else(|| {
                "template: expected array for wildcard *, got non-array".to_string()
            })?;
            let remaining = segments[i + 1..].join(".");
            let mut vals = Vec::with_capacity(arr.len());
            for item in arr {
                if remaining.is_empty() {
                    vals.push(leaf(item));
                } else {
                    vals.push(navigate_path(item, &remaining, leaf)?);
                }
            }
            return Ok(vals.join(","));
        }

        // Try as array index first.
        if let Ok(idx) = seg.parse::<usize>() {
            let arr = current.as_array().ok_or_else(|| {
                format!("template: expected array at index {idx}, got non-array")
            })?;
            current = arr.get(idx).ok_or_else(|| {
                format!(
                    "template: array index {idx} out of bounds (len {})",
                    arr.len()
                )
            })?;
            continue;
        }

        // Object field.
        let obj = current
            .as_object()
            .ok_or_else(|| format!("template: expected object at field {seg:?}, got non-object"))?;
        current = obj
            .get(*seg)
            .ok_or_else(|| format!("template: field {seg:?} not found in object"))?;
    }

    Ok(leaf(current))
}

/// String value of a JSON scalar: strings are unquoted; numbers, bools, null,
/// and composites are returned as their JSON text.
///
/// This is the leaf renderer for the query-string path, whose top-level
/// transform URL-encodes the result — so the unescaped content is safe there.
fn unquote_json(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Leaf renderer for the JSON-body path (round-45 F1, SECURITY.md invariant 27).
///
/// A JSON string value is emitted as its escaped CONTENT WITHOUT the surrounding
/// quotes — the template's own quotes (`"{{x}}"`) delimit it — so a value
/// containing `"` / `\` / control chars stays inside its string literal and can
/// NOT inject new keys into the body. Non-string scalars (number / bool / null)
/// and composites are returned as their literal JSON text, preserving the
/// numeric `{"id": {{x}}}` case.
fn json_string_escape(v: &Value) -> String {
    match v {
        Value::String(_) => {
            // `to_string` of a string yields a quoted, escaped JSON string; drop
            // the surrounding ASCII quotes so the template's own quotes delimit
            // it. serde_json does not HTML-escape, matching the Go sibling.
            let quoted = serde_json::to_string(v).unwrap_or_default();
            quoted
                .get(1..quoted.len().saturating_sub(1))
                .unwrap_or("")
                .to_string()
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn results(pairs: &[(&str, Value)]) -> HashMap<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn test_resolve_templates_no_templates() {
        let raw = r#"{"name":"test","value":42}"#;
        let out = resolve_templates(raw, &HashMap::new()).unwrap();
        assert_eq!(out, raw);
    }

    #[test]
    fn test_resolve_templates_simple_field() {
        let r = results(&[("op1", json!({"id":123,"name":"test"}))]);
        let raw = r#"{"order_id":"{{op1.id}}","label":"{{op1.name}}"}"#;
        let out = resolve_templates(raw, &r).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["order_id"], "123");
        assert_eq!(parsed["label"], "test");
    }

    #[test]
    fn test_resolve_templates_array_index() {
        let r = results(&[("op1", json!([{"id":10},{"id":20}]))]);
        let raw = r#"{"ref":"{{op1.0.id}}"}"#;
        let out = resolve_templates(raw, &r).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ref"], "10");
    }

    #[test]
    fn test_resolve_templates_missing_op() {
        let raw = r#"{"ref":"{{missing.id}}"}"#;
        assert!(resolve_templates(raw, &HashMap::new()).is_err());
    }

    #[test]
    fn test_resolve_templates_missing_field() {
        let r = results(&[("op1", json!({"id":123}))]);
        let raw = r#"{"ref":"{{op1.nonexistent}}"}"#;
        assert!(resolve_templates(raw, &r).is_err());
    }

    #[test]
    fn test_resolve_templates_in_string() {
        let r = results(&[("order", json!({"id":42}))]);
        let out = resolve_templates_in_string("id=eq.{{order.id}}&select=*", &r).unwrap();
        assert_eq!(out, "id=eq.42&select=*");
    }

    #[test]
    fn test_resolve_templates_uuid_string() {
        let r = results(&[(
            "op1",
            json!({"id":"550e8400-e29b-41d4-a716-446655440000"}),
        )]);
        let raw = r#"{"ref":"{{op1.id}}"}"#;
        let out = resolve_templates(raw, &r).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ref"], "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn test_resolve_templates_empty() {
        let out = resolve_templates("", &HashMap::new()).unwrap();
        assert_eq!(out, "");
    }

    #[test]
    fn test_resolve_templates_multiple_errors() {
        let r = results(&[("op1", json!({"id":1}))]);
        let raw = r#"{"a":"{{missing1.id}}","b":"{{missing2.id}}"}"#;
        let err = resolve_templates(raw, &r).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("missing1") && msg.contains("missing2"));
    }

    #[test]
    fn test_resolve_templates_wildcard() {
        let r = results(&[("rows", json!([{"id":10},{"id":20},{"id":30}]))]);
        let out = resolve_templates_in_string("id=in.({{rows.*.id}})", &r).unwrap();
        assert_eq!(out, "id=in.(10,20,30)");
    }

    #[test]
    fn test_resolve_templates_wildcard_scalar() {
        let r = results(&[("tags", json!(["alpha", "beta", "gamma"]))]);
        let out = resolve_templates_in_string("{{tags.*}}", &r).unwrap();
        assert_eq!(out, "alpha,beta,gamma");
    }

    // round-45 F1 HIGH (SECURITY.md invariant 27). A resolved STRING value must
    // be JSON-escaped before substitution into a JSON body position, so a prior
    // op's attacker-controlled value cannot break out of its string literal and
    // inject new top-level keys (structural JSON injection). Pre-fix this body
    // resolved to `{"name":"a","admin":"true"}` with a forged top-level `admin`
    // key; after the fix the value round-trips as a literal string.
    #[test]
    fn test_resolve_templates_json_injection() {
        let payload = r#"a","admin":"true"#;
        let r = results(&[("op", json!({ "val": payload }))]);
        let raw = r#"{"name":"{{op.val}}"}"#;

        let out = resolve_templates(raw, &r).unwrap();
        let parsed: Value = serde_json::from_str(&out)
            .unwrap_or_else(|e| panic!("invalid JSON result: {e} — raw: {out}"));

        let obj = parsed.as_object().expect("object");
        assert!(
            !obj.contains_key("admin"),
            "structural JSON injection: forged top-level 'admin' key present — raw: {out}"
        );
        assert_eq!(
            parsed["name"], payload,
            "name must round-trip as the literal payload — raw: {out}"
        );
        assert_eq!(obj.len(), 1, "expected exactly one top-level key — raw: {out}");
    }

    // The escaping fix must not break the legitimate non-string position
    // `{"id": {{x}}}`: a numeric scalar is still emitted as bare JSON text.
    #[test]
    fn test_resolve_templates_numeric_position_preserved() {
        let r = results(&[("op", json!({ "id": 123 }))]);
        let raw = r#"{"id": {{op.id}}}"#;
        let out = resolve_templates(raw, &r).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["id"], json!(123));
    }
}
