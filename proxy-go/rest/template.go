package rest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// leafFunc renders a resolved JSON scalar into the text substituted at a
// template position. The JSON-body path (ResolveTemplates) and the
// query-string path (ResolveTemplatesInString) need different leaf rendering:
// the body path must JSON-escape string content so a value cannot break out of
// its string literal and inject structure (round-45 F1); the query path emits
// the raw string value and URL-encodes it at the top.
type leafFunc func(json.RawMessage) string

// templateRe matches {{opId.field}} or {{opId.N.field}} patterns in JSON strings.
var templateRe = regexp.MustCompile(`\{\{([^}]+)\}\}`)

// ResolveTemplates replaces all {{opId.field}} references in raw JSON with
// values extracted from previous operation results.  Returns the resolved JSON.
//
// Substituted STRING values are JSON-string-escaped (round-45 F1): a value such
// as `a","admin":"true` from a prior op is emitted as `a\",\"admin\":\"true`,
// so it stays a string literal inside the `"{{x}}"` template position and can
// NOT inject new keys into the request body. Non-string scalars (number / bool
// / null) are emitted as their literal JSON text, so a bare `{"id": {{x}}}`
// numeric position keeps working.
func ResolveTemplates(raw json.RawMessage, results map[string]json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 {
		return raw, nil
	}

	s := string(raw)
	if !strings.Contains(s, "{{") {
		return raw, nil
	}

	var errs []string
	resolved := templateRe.ReplaceAllStringFunc(s, func(match string) string {
		expr := match[2 : len(match)-2]
		val, err := resolveExpression(expr, results, jsonStringEscape)
		if err != nil {
			errs = append(errs, err.Error())
			return match
		}
		return val
	})

	if len(errs) > 0 {
		return nil, fmt.Errorf("template resolution errors: %s", strings.Join(errs, "; "))
	}

	return json.RawMessage(resolved), nil
}

// ResolveTemplatesInString replaces {{opId.field}} references in a plain string
// (e.g., a query string).  Returns the resolved string.
//
// Individual resolved values are URL-encoded before substitution to prevent
// injection of additional query parameters via characters like '&' or '=' in
// the value. Wildcard expansions encode each element separately so that the
// structural commas between elements are preserved.
func ResolveTemplatesInString(s string, results map[string]json.RawMessage) (string, error) {
	if !strings.Contains(s, "{{") {
		return s, nil
	}

	var errs []string
	resolved := templateRe.ReplaceAllStringFunc(s, func(match string) string {
		expr := match[2 : len(match)-2]
		val, err := resolveExpression(expr, results, unquoteJSON)
		if err != nil {
			errs = append(errs, err.Error())
			return match
		}
		return urlEncodePreservingCommas(val)
	})

	if len(errs) > 0 {
		return "", fmt.Errorf("template resolution errors: %s", strings.Join(errs, "; "))
	}
	return resolved, nil
}

// urlEncodePreservingCommas URL-encodes each comma-separated segment
// individually so that structural commas (from wildcard expansions like
// {{op.*.id}}) are not encoded, while values containing '&' or '=' are
// safely escaped.
func urlEncodePreservingCommas(s string) string {
	parts := strings.Split(s, ",")
	for i, p := range parts {
		parts[i] = url.QueryEscape(p)
	}
	return strings.Join(parts, ",")
}

// resolveExpression navigates a dot-path like "op1.id" or "op1.0.name" into
// the results map.  Returns the string representation of the value, rendered
// through leaf (unquoteJSON for the query path, jsonStringEscape for the
// JSON-body path).
func resolveExpression(expr string, results map[string]json.RawMessage, leaf leafFunc) (string, error) {
	parts := strings.SplitN(expr, ".", 2)
	if len(parts) == 0 {
		return "", fmt.Errorf("template: empty expression")
	}

	opID := parts[0]
	data, ok := results[opID]
	if !ok {
		return "", fmt.Errorf("template: operation %q not found", opID)
	}

	if len(parts) == 1 {
		// No field path — return raw JSON value rendered by leaf.
		return leaf(data), nil
	}

	return navigatePath(data, parts[1], leaf)
}

// navigatePath traverses a dot-separated path into a JSON value.
// Supports: "field", "N" (array index), "N.field" (index then field).
func navigatePath(data json.RawMessage, path string, leaf leafFunc) (string, error) {
	segments := strings.Split(path, ".")
	current := data

	for i, seg := range segments {
		trimmed := strings.TrimSpace(string(current))
		if trimmed == "null" {
			return "", fmt.Errorf("template: cannot navigate into null at %q", seg)
		}

		// Wildcard: collect a field from every element of an array.
		// {{op1.*.id}} → comma-separated list of id values, suitable for
		// PostgREST in-filters: ?id=in.({{op1.*.id}})
		if seg == "*" {
			var arr []json.RawMessage
			if err := json.Unmarshal(current, &arr); err != nil {
				return "", fmt.Errorf("template: expected array for wildcard *, got non-array")
			}
			remaining := strings.Join(segments[i+1:], ".")
			vals := make([]string, 0, len(arr))
			for _, item := range arr {
				var v string
				var err error
				if remaining == "" {
					v = leaf(item)
				} else {
					v, err = navigatePath(item, remaining, leaf)
					if err != nil {
						return "", err
					}
				}
				vals = append(vals, v)
			}
			return strings.Join(vals, ","), nil
		}

		// Try as array index first.
		if idx, err := strconv.Atoi(seg); err == nil {
			var arr []json.RawMessage
			if err := json.Unmarshal(current, &arr); err != nil {
				return "", fmt.Errorf("template: expected array at index %d, got non-array", idx)
			}
			if idx < 0 || idx >= len(arr) {
				return "", fmt.Errorf("template: array index %d out of bounds (len %d)", idx, len(arr))
			}
			current = arr[idx]
			continue
		}

		// Object field.
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(current, &obj); err != nil {
			return "", fmt.Errorf("template: expected object at field %q, got non-object", seg)
		}
		val, ok := obj[seg]
		if !ok {
			return "", fmt.Errorf("template: field %q not found in object", seg)
		}
		current = val
	}

	return leaf(current), nil
}

// unquoteJSON returns the string value of a JSON scalar.
// JSON strings are unquoted; numbers, bools, null returned as-is.
//
// This is the leaf renderer for the query-string path, whose top-level
// transform URL-encodes the result — so the unescaped content is safe there.
func unquoteJSON(raw json.RawMessage) string {
	s := strings.TrimSpace(string(raw))
	if len(s) >= 2 && s[0] == '"' {
		var unquoted string
		if err := json.Unmarshal(raw, &unquoted); err == nil {
			return unquoted
		}
	}
	return s
}

// jsonStringEscape is the leaf renderer for the JSON-body path (round-45 F1).
// A JSON string value is emitted as its escaped CONTENT WITHOUT the surrounding
// quotes — the template's own quotes (`"{{x}}"`) delimit it — so a value
// containing `"` / `\` / control chars stays inside its string literal and can
// not inject new keys into the body. Non-string scalars (number / bool / null)
// and composites are returned as their literal JSON text, preserving the
// numeric `{"id": {{x}}}` case. HTML escaping is disabled so the output matches
// the Rust sibling (serde_json) byte-for-byte.
func jsonStringEscape(raw json.RawMessage) string {
	s := strings.TrimSpace(string(raw))
	if len(s) >= 1 && s[0] == '"' {
		var decoded string
		if err := json.Unmarshal(raw, &decoded); err == nil {
			var buf bytes.Buffer
			enc := json.NewEncoder(&buf)
			enc.SetEscapeHTML(false)
			if err := enc.Encode(decoded); err == nil {
				// Encoder writes a quoted JSON string plus a trailing '\n'.
				out := strings.TrimRight(buf.String(), "\n")
				return out[1 : len(out)-1]
			}
		}
	}
	return s
}
