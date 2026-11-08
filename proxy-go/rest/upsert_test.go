package rest

import (
	"strings"
	"testing"
)

// Reproduces a browser game's cloud-save 409: the SDK's upsert() sends
// POST /rest/v1/{table}?on_conflict=<cols> with Prefer: resolution=
// merge-duplicates, but the proxy built a plain INSERT — the second save of
// the same profile hit the primary key and mapped 23505 → 409 "duplicate
// value violates unique constraint". These tests pin the desired contract:
// the builders emit ON CONFLICT clauses and the Prefer/on_conflict parser
// resolves the conflict target (explicit columns, else the primary key).

func upsertTestTable() *TableMeta {
	return &TableMeta{
		Schema: "public",
		Name:   "profiles",
		Columns: []ColumnMeta{
			{Name: "user_id", PGType: "uuid"},
			{Name: "display_name", PGType: "text"},
			{Name: "save", PGType: "jsonb"},
			{Name: "client_ts", PGType: "int8"},
		},
		PrimaryKeys: []string{"user_id"},
	}
}

func TestBuildInsert_MergeDuplicates(t *testing.T) {
	table := upsertTestTable()
	body := map[string]any{
		"user_id":   "00000000-0000-0000-0000-000000000001",
		"save":      `{"gold":5}`,
		"client_ts": 42,
	}
	bq, err := BuildInsert(table, body, &UpsertSpec{Columns: []string{"user_id"}})
	if err != nil {
		t.Fatalf("BuildInsert(merge): %v", err)
	}
	sql := bq.SQL
	if !strings.Contains(sql, `ON CONFLICT ("user_id") DO UPDATE SET`) {
		t.Fatalf("missing ON CONFLICT DO UPDATE clause:\n%s", sql)
	}
	// Every inserted column except the conflict target is updated from EXCLUDED.
	for _, want := range []string{`"client_ts" = EXCLUDED."client_ts"`, `"save" = EXCLUDED."save"`} {
		if !strings.Contains(sql, want) {
			t.Fatalf("missing %s in DO UPDATE SET:\n%s", want, sql)
		}
	}
	if strings.Contains(sql, `"user_id" = EXCLUDED."user_id"`) {
		t.Fatalf("conflict column must not appear in DO UPDATE SET:\n%s", sql)
	}
	if !strings.Contains(sql, "RETURNING *") {
		t.Fatalf("upsert must keep RETURNING *:\n%s", sql)
	}
}

func TestBuildInsert_IgnoreDuplicates(t *testing.T) {
	table := upsertTestTable()
	body := map[string]any{"user_id": "u", "save": "{}"}
	bq, err := BuildInsert(table, body, &UpsertSpec{Columns: []string{"user_id"}, IgnoreDuplicates: true})
	if err != nil {
		t.Fatalf("BuildInsert(ignore): %v", err)
	}
	if !strings.Contains(bq.SQL, `ON CONFLICT ("user_id") DO NOTHING`) {
		t.Fatalf("missing ON CONFLICT DO NOTHING:\n%s", bq.SQL)
	}
}

func TestBuildInsert_AllColumnsConflict_FallsBackToDoNothing(t *testing.T) {
	// Nothing left to update when every inserted column is part of the
	// conflict target — DO UPDATE SET with an empty list is invalid SQL.
	table := upsertTestTable()
	body := map[string]any{"user_id": "u"}
	bq, err := BuildInsert(table, body, &UpsertSpec{Columns: []string{"user_id"}})
	if err != nil {
		t.Fatalf("BuildInsert(all-conflict): %v", err)
	}
	if !strings.Contains(bq.SQL, `ON CONFLICT ("user_id") DO NOTHING`) {
		t.Fatalf("expected DO NOTHING fallback:\n%s", bq.SQL)
	}
}

func TestBuildInsert_NilSpec_PlainInsert(t *testing.T) {
	table := upsertTestTable()
	body := map[string]any{"user_id": "u"}
	bq, err := BuildInsert(table, body, nil)
	if err != nil {
		t.Fatalf("BuildInsert(nil spec): %v", err)
	}
	if strings.Contains(bq.SQL, "ON CONFLICT") {
		t.Fatalf("plain insert must not contain ON CONFLICT:\n%s", bq.SQL)
	}
}

func TestBuildInsert_UnknownConflictColumn(t *testing.T) {
	table := upsertTestTable()
	body := map[string]any{"user_id": "u"}
	if _, err := BuildInsert(table, body, &UpsertSpec{Columns: []string{"nope"}}); err == nil {
		t.Fatal("expected error for unknown on_conflict column")
	}
}

func TestBuildBulkInsert_MergeDuplicates(t *testing.T) {
	table := upsertTestTable()
	rows := []map[string]any{
		{"user_id": "a", "save": "{}"},
		{"user_id": "b", "save": "{}", "client_ts": 7},
	}
	bq, err := BuildBulkInsert(table, rows, &UpsertSpec{Columns: []string{"user_id"}})
	if err != nil {
		t.Fatalf("BuildBulkInsert(merge): %v", err)
	}
	if !strings.Contains(bq.SQL, `ON CONFLICT ("user_id") DO UPDATE SET`) {
		t.Fatalf("missing ON CONFLICT DO UPDATE in bulk:\n%s", bq.SQL)
	}
}

func TestParseUpsertSpec(t *testing.T) {
	table := upsertTestTable()

	// No resolution preference → no upsert, on_conflict alone is ignored.
	if spec, err := ParseUpsertSpec("return=minimal", "user_id", table); err != nil || spec != nil {
		t.Fatalf("no resolution: want nil spec, got %+v err=%v", spec, err)
	}

	// merge-duplicates with explicit column.
	spec, err := ParseUpsertSpec("resolution=merge-duplicates", "user_id", table)
	if err != nil || spec == nil || spec.IgnoreDuplicates {
		t.Fatalf("merge: got %+v err=%v", spec, err)
	}
	if len(spec.Columns) != 1 || spec.Columns[0] != "user_id" {
		t.Fatalf("merge: wrong columns %v", spec.Columns)
	}

	// resolution present, on_conflict absent → default to the primary key.
	spec, err = ParseUpsertSpec("resolution=merge-duplicates", "", table)
	if err != nil || spec == nil || len(spec.Columns) != 1 || spec.Columns[0] != "user_id" {
		t.Fatalf("pk default: got %+v err=%v", spec, err)
	}

	// ignore-duplicates flavour.
	spec, err = ParseUpsertSpec("resolution=ignore-duplicates", "user_id", table)
	if err != nil || spec == nil || !spec.IgnoreDuplicates {
		t.Fatalf("ignore: got %+v err=%v", spec, err)
	}

	// Comma-separated multi-column target.
	multi := &TableMeta{
		Schema:      "public",
		Name:        "t",
		Columns:     []ColumnMeta{{Name: "a"}, {Name: "b"}, {Name: "v"}},
		PrimaryKeys: []string{"a", "b"},
	}
	spec, err = ParseUpsertSpec("resolution=merge-duplicates", "a,b", multi)
	if err != nil || spec == nil || len(spec.Columns) != 2 {
		t.Fatalf("multi: got %+v err=%v", spec, err)
	}

	// resolution set, no on_conflict, table without a PK → error (400 at the handler).
	noPK := &TableMeta{Schema: "public", Name: "t", Columns: []ColumnMeta{{Name: "v"}}}
	if _, err := ParseUpsertSpec("resolution=merge-duplicates", "", noPK); err == nil {
		t.Fatal("no PK and no on_conflict: expected error")
	}
}
