package rest

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// templateRe matches {{opId.field}} or {{opId.N.field}} patterns in JSON strings.
var templateRe = regexp.MustCompile(`\{\{([^}]+)\}\}`)

// ResolveTemplates replaces all {{opId.field}} references in raw JSON with
// values extracted from previous operation results.  Returns the resolved JSON.
func ResolveTemplates(raw json.RawMessage, results map[string]json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 {
		return raw, nil
	}

	s := string(raw)
	if !strings.Contains(s, "{{") {
		return raw, nil
	}

	var resolveErr error
	resolved := templateRe.ReplaceAllStringFunc(s, func(match string) string {
		if resolveErr != nil {
			return match
		}

		// Strip {{ and }}
		expr := match[2 : len(match)-2]
		val, err := resolveExpression(expr, results)
		if err != nil {
			resolveErr = err
			return match
		}
		return val
	})

	if resolveErr != nil {
		return nil, resolveErr
	}

	return json.RawMessage(resolved), nil
}

// ResolveTemplatesInString replaces {{opId.field}} references in a plain string
// (e.g., a query string).  Returns the resolved string.
func ResolveTemplatesInString(s string, results map[string]json.RawMessage) (string, error) {
	if !strings.Contains(s, "{{") {
		return s, nil
	}

	var resolveErr error
	resolved := templateRe.ReplaceAllStringFunc(s, func(match string) string {
		if resolveErr != nil {
			return match
		}

		expr := match[2 : len(match)-2]
		val, err := resolveExpression(expr, results)
		if err != nil {
			resolveErr = err
			return match
		}
		return val
	})

	if resolveErr != nil {
		return "", resolveErr
	}
	return resolved, nil
}

// resolveExpression navigates a dot-path like "op1.id" or "op1.0.name" into
// the results map.  Returns the string representation of the value.
func resolveExpression(expr string, results map[string]json.RawMessage) (string, error) {
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
		// No field path — return raw JSON value (unquoted if string).
		return unquoteJSON(data), nil
	}

	return navigatePath(data, parts[1])
}

// navigatePath traverses a dot-separated path into a JSON value.
// Supports: "field", "N" (array index), "N.field" (index then field).
func navigatePath(data json.RawMessage, path string) (string, error) {
	segments := strings.Split(path, ".")
	current := data

	for _, seg := range segments {
		trimmed := strings.TrimSpace(string(current))
		if trimmed == "null" {
			return "", fmt.Errorf("template: cannot navigate into null at %q", seg)
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

	return unquoteJSON(current), nil
}

// unquoteJSON returns the string value of a JSON scalar.
// JSON strings are unquoted; numbers, bools, null returned as-is.
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
