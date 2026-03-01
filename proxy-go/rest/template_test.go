package rest

import (
	"encoding/json"
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
