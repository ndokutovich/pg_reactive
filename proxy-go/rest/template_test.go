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

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}
