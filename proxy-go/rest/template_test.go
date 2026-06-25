package rest

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestResolveTemplates_NoTemplates(t *testing.T) {
	raw := json.RawMessage(`{"name":"test","value":42}`)
	result, err := ResolveTemplates(raw, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(result) != string(raw) {
		t.Fatalf("expected %s, got %s", raw, result)
	}
}

func TestResolveTemplates_SimpleField(t *testing.T) {
	results := map[string]json.RawMessage{
		"op1": json.RawMessage(`{"id":123,"name":"test"}`),
	}
	raw := json.RawMessage(`{"order_id":"{{op1.id}}","label":"{{op1.name}}"}`)
	result, err := ResolveTemplates(raw, results)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(result, &parsed); err != nil {
		t.Fatalf("invalid JSON result: %v — raw: %s", err, result)
	}
	if parsed["order_id"] != "123" {
		t.Fatalf("expected order_id=123, got %v", parsed["order_id"])
	}
	if parsed["label"] != "test" {
		t.Fatalf("expected label=test, got %v", parsed["label"])
	}
}

func TestResolveTemplates_ArrayIndex(t *testing.T) {
	results := map[string]json.RawMessage{
		"op1": json.RawMessage(`[{"id":10},{"id":20}]`),
	}
	raw := json.RawMessage(`{"ref":"{{op1.0.id}}"}`)
	result, err := ResolveTemplates(raw, results)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(result, &parsed); err != nil {
		t.Fatalf("invalid JSON result: %v — raw: %s", err, result)
	}
	if parsed["ref"] != "10" {
		t.Fatalf("expected ref=10, got %v", parsed["ref"])
	}
}

func TestResolveTemplates_MissingOp(t *testing.T) {
	results := map[string]json.RawMessage{}
	raw := json.RawMessage(`{"ref":"{{missing.id}}"}`)
	_, err := ResolveTemplates(raw, results)
	if err == nil {
		t.Fatal("expected error for missing operation")
	}
}

func TestResolveTemplates_MissingField(t *testing.T) {
	results := map[string]json.RawMessage{
		"op1": json.RawMessage(`{"id":123}`),
	}
	raw := json.RawMessage(`{"ref":"{{op1.nonexistent}}"}`)
	_, err := ResolveTemplates(raw, results)
	if err == nil {
		t.Fatal("expected error for missing field")
	}
}

func TestResolveTemplatesInString(t *testing.T) {
	results := map[string]json.RawMessage{
		"order": json.RawMessage(`{"id":42}`),
	}
	s := "id=eq.{{order.id}}&select=*"
	result, err := ResolveTemplatesInString(s, results)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "id=eq.42&select=*" {
		t.Fatalf("expected id=eq.42&select=*, got %s", result)
	}
}

func TestResolveTemplates_UUIDString(t *testing.T) {
	results := map[string]json.RawMessage{
		"op1": json.RawMessage(`{"id":"550e8400-e29b-41d4-a716-446655440000"}`),
	}
	raw := json.RawMessage(`{"ref":"{{op1.id}}"}`)
	result, err := ResolveTemplates(raw, results)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(result, &parsed); err != nil {
		t.Fatalf("invalid JSON result: %v — raw: %s", err, result)
	}
	if parsed["ref"] != "550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("expected UUID, got %v", parsed["ref"])
	}
}

func TestResolveTemplates_Empty(t *testing.T) {
	result, err := ResolveTemplates(nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Fatalf("expected nil, got %s", result)
	}
}

func TestResolveTemplates_MultipleErrors(t *testing.T) {
	results := map[string]json.RawMessage{
		"op1": json.RawMessage(`{"id":1}`),
	}
	// Two broken references in the same template.
	raw := json.RawMessage(`{"a":"{{missing1.id}}","b":"{{missing2.id}}"}`)
	_, err := ResolveTemplates(raw, results)
	if err == nil {
		t.Fatal("expected error for multiple missing operations")
	}
	errStr := err.Error()
	if !containsAll(errStr, "missing1", "missing2") {
		t.Fatalf("expected both missing ops in error, got: %s", errStr)
	}
}

func TestResolveTemplates_Wildcard(t *testing.T) {
	results := map[string]json.RawMessage{
		"rows": json.RawMessage(`[{"id":10},{"id":20},{"id":30}]`),
	}
	s := "id=in.({{rows.*.id}})"
	result, err := ResolveTemplatesInString(s, results)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "id=in.(10,20,30)" {
		t.Fatalf("expected id=in.(10,20,30), got %s", result)
	}
}

func TestResolveTemplates_WildcardScalar(t *testing.T) {
	results := map[string]json.RawMessage{
		"tags": json.RawMessage(`["alpha","beta","gamma"]`),
	}
	s := "{{tags.*}}"
	result, err := ResolveTemplatesInString(s, results)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "alpha,beta,gamma" {
		t.Fatalf("expected alpha,beta,gamma, got %s", result)
	}
}

// TestResolveTemplates_JSONInjection — round-45 F1 HIGH (SECURITY.md invariant
// 27). A resolved STRING value must be JSON-escaped before substitution into a
// JSON body position, so a prior op's attacker-controlled value cannot break
// out of its string literal and inject new top-level keys (structural JSON
// injection). Pre-fix this body resolved to `{"name":"a","admin":"true",...}`
// with a forged top-level `admin` key; after the fix the value round-trips as a
// literal string and no `admin` key exists.
func TestResolveTemplates_JSONInjection(t *testing.T) {
	const payload = `a","admin":"true`
	results := map[string]json.RawMessage{
		"op": json.RawMessage(`{"val":` + mustJSON(payload) + `}`),
	}
	raw := json.RawMessage(`{"name":"{{op.val}}"}`)

	result, err := ResolveTemplates(raw, results)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(result, &parsed); err != nil {
		t.Fatalf("invalid JSON result: %v — raw: %s", err, result)
	}
	if _, injected := parsed["admin"]; injected {
		t.Fatalf("structural JSON injection: forged top-level 'admin' key present — raw: %s", result)
	}
	if parsed["name"] != payload {
		t.Fatalf("expected name to round-trip as the literal payload %q, got %v — raw: %s", payload, parsed["name"], result)
	}
	if len(parsed) != 1 {
		t.Fatalf("expected exactly one top-level key, got %d: %v", len(parsed), parsed)
	}
}

// TestResolveTemplates_NumericPositionPreserved — the escaping fix must not
// break the legitimate non-string position `{"id": {{x}}}`: a numeric scalar
// is still emitted as bare JSON text, not a quoted string.
func TestResolveTemplates_NumericPositionPreserved(t *testing.T) {
	results := map[string]json.RawMessage{
		"op": json.RawMessage(`{"id":123}`),
	}
	raw := json.RawMessage(`{"id": {{op.id}}}`)
	result, err := ResolveTemplates(raw, results)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(result, &parsed); err != nil {
		t.Fatalf("invalid JSON result: %v — raw: %s", err, result)
	}
	if parsed["id"] != float64(123) {
		t.Fatalf("expected numeric id=123, got %v (%T)", parsed["id"], parsed["id"])
	}
}

func mustJSON(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}
