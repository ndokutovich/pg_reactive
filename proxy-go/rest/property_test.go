package rest

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"testing"

	"pgregory.net/rapid"
)

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

var pgTypes = []string{"integer", "text", "boolean", "uuid", "timestamptz"}
var filterOps = []FilterOp{OpEq, OpGt, OpLt, OpLike}

// genColumnMeta generates a ColumnMeta with a safe identifier name and a
// random PG type from the pgTypes list.
func genColumnMeta(t *rapid.T, prefix string, ordinal int) ColumnMeta {
	typ := rapid.SampledFrom(pgTypes).Draw(t, prefix+"_type")
	return ColumnMeta{
		Name:       prefix,
		PGType:     typ,
		IsNullable: rapid.Bool().Draw(t, prefix+"_nullable"),
		HasDefault: rapid.Bool().Draw(t, prefix+"_hasdefault"),
		Ordinal:    ordinal,
	}
}

// genTableMeta generates a TableMeta with 1-5 columns using safe identifier
// names (col0, col1, ...). The table lives in schema "public".
func genTableMeta(t *rapid.T) *TableMeta {
	nCols := rapid.IntRange(1, 5).Draw(t, "ncols")
	cols := make([]ColumnMeta, nCols)
	for i := 0; i < nCols; i++ {
		name := fmt.Sprintf("col%d", i)
		cols[i] = genColumnMeta(t, name, i+1)
	}
	return &TableMeta{
		Schema:  "public",
		Name:    "test_table",
		Columns: cols,
	}
}

// genFilter generates a Filter targeting one of the columns in the table,
// using one of the allowed operators.
func genFilter(t *rapid.T, table *TableMeta, label string) Filter {
	colIdx := rapid.IntRange(0, len(table.Columns)-1).Draw(t, label+"_colidx")
	col := table.Columns[colIdx]
	op := rapid.SampledFrom(filterOps).Draw(t, label+"_op")
	val := rapid.StringMatching(`[a-zA-Z0-9_]{1,10}`).Draw(t, label+"_val")
	return Filter{
		Column: col.Name,
		Op:     op,
		Value:  val,
		Negate: false,
	}
}

// genRestQuery generates a RestQuery with 0-3 filters whose columns exist in
// the table.
func genRestQuery(t *rapid.T, table *TableMeta) *RestQuery {
	nFilters := rapid.IntRange(0, 3).Draw(t, "nfilters")
	filters := make([]Filter, nFilters)
	for i := 0; i < nFilters; i++ {
		filters[i] = genFilter(t, table, fmt.Sprintf("filter%d", i))
	}
	return &RestQuery{Filters: filters}
}

// genRestQueryWithFilters generates a RestQuery with at least 1 filter.
func genRestQueryWithFilters(t *rapid.T, table *TableMeta) *RestQuery {
	nFilters := rapid.IntRange(1, 3).Draw(t, "nfilters")
	filters := make([]Filter, nFilters)
	for i := 0; i < nFilters; i++ {
		filters[i] = genFilter(t, table, fmt.Sprintf("filter%d", i))
	}
	return &RestQuery{Filters: filters}
}

// ---------------------------------------------------------------------------
// Placeholder helpers
// ---------------------------------------------------------------------------

// placeholderRe matches $N placeholders in SQL.
var placeholderRe = regexp.MustCompile(`\$(\d+)`)

// extractPlaceholders returns all unique $N numbers found in the SQL string.
func extractPlaceholders(sql string) []int {
	matches := placeholderRe.FindAllStringSubmatch(sql, -1)
	seen := map[int]bool{}
	var nums []int
	for _, m := range matches {
		var n int
		fmt.Sscanf(m[1], "%d", &n)
		if !seen[n] {
			seen[n] = true
			nums = append(nums, n)
		}
	}
	sort.Ints(nums)
	return nums
}

// isContiguous checks that nums form a contiguous sequence 1..N.
func isContiguous(nums []int) bool {
	if len(nums) == 0 {
		return true
	}
	for i, n := range nums {
		if n != i+1 {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// Property 1: ParamCountMatchesPlaceholders
// ---------------------------------------------------------------------------

func TestProperty_ParamCountMatchesPlaceholders(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		table := genTableMeta(t)
		q := genRestQuery(t, table)

		// Try BuildSelect
		bq, err := BuildSelect(table, q, nil)
		if err != nil {
			return // trivially satisfied
		}
		nums := extractPlaceholders(bq.SQL)
		if len(nums) != len(bq.Params) {
			t.Fatalf("BuildSelect: %d placeholders but %d params\nSQL: %s", len(nums), len(bq.Params), bq.SQL)
		}
		if !isContiguous(nums) {
			t.Fatalf("BuildSelect: placeholders not contiguous 1..N: %v\nSQL: %s", nums, bq.SQL)
		}

		// Try BuildDelete (needs filters)
		if len(q.Filters) > 0 {
			bq, err = BuildDelete(table, q)
			if err != nil {
				return
			}
			nums = extractPlaceholders(bq.SQL)
			if len(nums) != len(bq.Params) {
				t.Fatalf("BuildDelete: %d placeholders but %d params\nSQL: %s", len(nums), len(bq.Params), bq.SQL)
			}
			if !isContiguous(nums) {
				t.Fatalf("BuildDelete: placeholders not contiguous: %v\nSQL: %s", nums, bq.SQL)
			}
		}

		// Try BuildInsert with a random body
		body := make(map[string]any)
		nBodyCols := rapid.IntRange(1, len(table.Columns)).Draw(t, "nbodycols")
		for i := 0; i < nBodyCols; i++ {
			body[table.Columns[i].Name] = "test_val"
		}
		bq, err = BuildInsert(table, body, nil)
		if err != nil {
			return
		}
		nums = extractPlaceholders(bq.SQL)
		if len(nums) != len(bq.Params) {
			t.Fatalf("BuildInsert: %d placeholders but %d params\nSQL: %s", len(nums), len(bq.Params), bq.SQL)
		}
		if !isContiguous(nums) {
			t.Fatalf("BuildInsert: placeholders not contiguous: %v\nSQL: %s", nums, bq.SQL)
		}

		// Try BuildUpdate (needs filters)
		if len(q.Filters) > 0 {
			bq, err = BuildUpdate(table, body, q)
			if err != nil {
				return
			}
			nums = extractPlaceholders(bq.SQL)
			if len(nums) != len(bq.Params) {
				t.Fatalf("BuildUpdate: %d placeholders but %d params\nSQL: %s", len(nums), len(bq.Params), bq.SQL)
			}
			if !isContiguous(nums) {
				t.Fatalf("BuildUpdate: placeholders not contiguous: %v\nSQL: %s", nums, bq.SQL)
			}
		}
	})
}

// ---------------------------------------------------------------------------
// Property 2: BulkInsertParamCount
// ---------------------------------------------------------------------------

func TestProperty_BulkInsertParamCount(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		table := genTableMeta(t)
		nRows := rapid.IntRange(1, 5).Draw(t, "nrows")
		rows := make([]map[string]any, nRows)

		// Each row uses 1-3 columns from the table.
		maxCols := len(table.Columns)
		if maxCols > 3 {
			maxCols = 3
		}
		for i := 0; i < nRows; i++ {
			row := make(map[string]any)
			nCols := rapid.IntRange(1, maxCols).Draw(t, fmt.Sprintf("row%d_ncols", i))
			for j := 0; j < nCols; j++ {
				row[table.Columns[j].Name] = fmt.Sprintf("val_%d_%d", i, j)
			}
			rows[i] = row
		}

		bq, err := BuildBulkInsert(table, rows, nil)
		if err != nil {
			return
		}

		// Compute column union size.
		colUnion := make(map[string]struct{})
		for _, row := range rows {
			for k := range row {
				colUnion[k] = struct{}{}
			}
		}
		expectedParams := nRows * len(colUnion)

		if len(bq.Params) != expectedParams {
			t.Fatalf("BulkInsert: expected %d params (%d rows * %d cols), got %d\nSQL: %s",
				expectedParams, nRows, len(colUnion), len(bq.Params), bq.SQL)
		}

		nums := extractPlaceholders(bq.SQL)
		if len(nums) != expectedParams {
			t.Fatalf("BulkInsert: expected %d placeholders, got %d\nSQL: %s",
				expectedParams, len(nums), bq.SQL)
		}
		if !isContiguous(nums) {
			t.Fatalf("BulkInsert: placeholders not contiguous: %v\nSQL: %s", nums, bq.SQL)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 3: SplitLogicalPreservesParens
// ---------------------------------------------------------------------------

func TestProperty_SplitLogicalPreservesParens(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		nSegs := rapid.IntRange(1, 5).Draw(t, "nsegs")
		segments := make([]string, nSegs)
		for i := 0; i < nSegs; i++ {
			// Some segments are simple, some have parenthesized sub-expressions.
			if rapid.Bool().Draw(t, fmt.Sprintf("seg%d_paren", i)) {
				// Parenthesized segment like "col.in.(a,b,c)"
				nInner := rapid.IntRange(1, 4).Draw(t, fmt.Sprintf("seg%d_inner", i))
				inner := make([]string, nInner)
				for j := 0; j < nInner; j++ {
					inner[j] = rapid.StringMatching(`[a-z]{1,5}`).Draw(t, fmt.Sprintf("seg%d_inner%d", i, j))
				}
				segments[i] = fmt.Sprintf("col%d.in.(%s)", i, strings.Join(inner, ","))
			} else {
				// Simple segment like "col.eq.val"
				val := rapid.StringMatching(`[a-z]{1,8}`).Draw(t, fmt.Sprintf("seg%d_val", i))
				segments[i] = fmt.Sprintf("col%d.eq.%s", i, val)
			}
		}

		joined := strings.Join(segments, ",")
		result := splitLogicalExprs(joined)

		if len(result) != len(segments) {
			t.Fatalf("expected %d segments, got %d\ninput: %q\nresult: %v",
				len(segments), len(result), joined, result)
		}
		for i, seg := range result {
			if seg != segments[i] {
				t.Fatalf("segment %d: expected %q, got %q", i, segments[i], seg)
			}
		}
	})
}

// ---------------------------------------------------------------------------
// Property 4: QuoteIdentRoundTrip
// ---------------------------------------------------------------------------

func TestProperty_QuoteIdentRoundTrip(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		// Generate strings that include tricky characters.
		s := rapid.OneOf(
			rapid.String(),
			rapid.StringMatching(`[a-zA-Z"\\;\-\-\n' ]{0,30}`),
			rapid.Just("Robert'); DROP TABLE students;--"),
			rapid.Just(`he said "hello"`),
			rapid.Just("line1\nline2"),
		).Draw(t, "ident")

		quoted := QuoteIdent(s)

		// Must start and end with double-quote.
		if !strings.HasPrefix(quoted, `"`) || !strings.HasSuffix(quoted, `"`) {
			t.Fatalf("QuoteIdent(%q) = %q — not wrapped in double quotes", s, quoted)
		}

		// Strip outer quotes, un-double inner quotes, should get original back.
		inner := quoted[1 : len(quoted)-1]
		recovered := strings.ReplaceAll(inner, `""`, `"`)
		if recovered != s {
			t.Fatalf("QuoteIdent round-trip failed:\n  input:     %q\n  quoted:    %q\n  recovered: %q", s, quoted, recovered)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 5: ColumnNamesAlwaysQuoted
// ---------------------------------------------------------------------------

func TestProperty_ColumnNamesAlwaysQuoted(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		// Use SQL keywords as column names.
		keywords := []string{"SELECT", "FROM", "WHERE", "TABLE", "INSERT", "DELETE", "UPDATE", "ORDER", "GROUP", "HAVING"}
		nCols := rapid.IntRange(1, 5).Draw(t, "ncols")
		cols := make([]ColumnMeta, nCols)
		chosen := make([]string, nCols)
		for i := 0; i < nCols; i++ {
			name := rapid.SampledFrom(keywords).Draw(t, fmt.Sprintf("kwcol%d", i))
			// Ensure uniqueness by appending index.
			name = fmt.Sprintf("%s%d", name, i)
			chosen[i] = name
			cols[i] = ColumnMeta{
				Name:    name,
				PGType:  "text",
				Ordinal: i + 1,
			}
		}
		table := &TableMeta{
			Schema:  "public",
			Name:    "kw_table",
			Columns: cols,
		}

		// Build a SELECT with a filter on the first column.
		q := &RestQuery{
			Filters: []Filter{
				{Column: chosen[0], Op: OpEq, Value: "testval"},
			},
		}
		bq, err := BuildSelect(table, q, chosen)
		if err != nil {
			return
		}

		// Every column used in the filter must appear quoted in the SQL.
		for _, c := range chosen {
			quoted := QuoteIdent(c)
			// The column should appear quoted in the SQL. An unquoted occurrence
			// of the bare name (not inside quotes) would be a quoting failure.
			if !strings.Contains(bq.SQL, quoted) {
				t.Fatalf("column %q not found as %s in SQL: %s", c, quoted, bq.SQL)
			}
		}
	})
}

// ---------------------------------------------------------------------------
// Property 6: DeleteRequiresFilters
// ---------------------------------------------------------------------------

func TestProperty_DeleteRequiresFilters(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		table := genTableMeta(t)
		q := &RestQuery{Filters: nil}

		_, err := BuildDelete(table, q)
		if err == nil {
			t.Fatal("BuildDelete with no filters should return an error")
		}
		if !strings.Contains(err.Error(), "filter") {
			t.Fatalf("expected error about filters, got: %v", err)
		}
	})
}

// Property 6b: Delete/Update with LogicalGroups but no top-level Filters should SUCCEED.
func TestProperty_DeleteWithLogicalGroupsSucceeds(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		table := genTableMeta(t)
		cols := make([]string, len(table.Columns))
		for i, c := range table.Columns {
			cols[i] = c.Name
		}
		if len(cols) == 0 {
			return
		}
		col := cols[0]

		q := &RestQuery{
			Filters: nil, // no top-level filters
			LogicalGroups: []LogicalGroup{
				{
					Operator: "or",
					Filters: []Filter{
						{Column: col, Op: OpEq, Value: "a"},
						{Column: col, Op: OpEq, Value: "b"},
					},
				},
			},
		}
		_, err := BuildDelete(table, q)
		if err != nil {
			t.Fatalf("BuildDelete with LogicalGroups should succeed, got: %v", err)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 7: SortStringsMatchesStdlib
// ---------------------------------------------------------------------------

func TestProperty_SortStringsMatchesStdlib(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		n := rapid.IntRange(0, 20).Draw(t, "n")
		s := make([]string, n)
		for i := 0; i < n; i++ {
			s[i] = rapid.String().Draw(t, fmt.Sprintf("s%d", i))
		}

		// Make two copies.
		ours := make([]string, len(s))
		copy(ours, s)
		stdlib := make([]string, len(s))
		copy(stdlib, s)

		sortStrings(ours)
		sort.Strings(stdlib)

		if len(ours) != len(stdlib) {
			t.Fatalf("length mismatch: %d vs %d", len(ours), len(stdlib))
		}
		for i := range ours {
			if ours[i] != stdlib[i] {
				t.Fatalf("mismatch at index %d: sortStrings=%q, sort.Strings=%q", i, ours[i], stdlib[i])
			}
		}
	})
}

// ---------------------------------------------------------------------------
// Property 8: SafePGTypeIdempotent
// ---------------------------------------------------------------------------

func TestProperty_SafePGTypeIdempotent(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		input := rapid.OneOf(
			// Valid PG types
			rapid.SampledFrom([]string{
				"integer", "text", "boolean", "uuid", "timestamptz",
				"character varying(255)", "numeric(10,2)", "integer[]",
				"double precision", "time without time zone",
			}),
			// Garbage / injection attempts
			rapid.String(),
			rapid.StringMatching(`[a-z;'"\-\-DROP ]{0,20}`),
		).Draw(t, "typ")

		once := SafePGType(input)
		twice := SafePGType(once)

		if once != twice {
			t.Fatalf("SafePGType not idempotent: SafePGType(%q)=%q, SafePGType(%q)=%q",
				input, once, once, twice)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 9: WildcardTemplateCardinality
// ---------------------------------------------------------------------------

func TestProperty_WildcardTemplateCardinality(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		n := rapid.IntRange(1, 10).Draw(t, "n")

		// Build an array of N objects, each with a single "id" field.
		items := make([]map[string]int, n)
		for i := 0; i < n; i++ {
			items[i] = map[string]int{"id": rapid.Int().Draw(t, fmt.Sprintf("id%d", i))}
		}
		data, err := json.Marshal(items)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		results := map[string]json.RawMessage{
			"op": json.RawMessage(data),
		}

		// Resolve {{op.*.id}} — should produce N comma-separated values.
		resolved, err := ResolveTemplatesInString("{{op.*.id}}", results)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		parts := strings.Split(resolved, ",")
		if len(parts) != n {
			t.Fatalf("expected %d comma-separated values, got %d: %q", n, len(parts), resolved)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 10: NoTemplateIdentity
// ---------------------------------------------------------------------------

func TestProperty_NoTemplateIdentity(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		// Generate valid JSON without "{{".
		// Build a random JSON object with safe string values.
		nKeys := rapid.IntRange(0, 5).Draw(t, "nkeys")
		obj := make(map[string]any, nKeys)
		for i := 0; i < nKeys; i++ {
			key := rapid.StringMatching(`[a-z]{1,8}`).Draw(t, fmt.Sprintf("key%d", i))
			// Ensure value does not contain "{{".
			val := rapid.StringMatching(`[a-zA-Z0-9_ ]{0,20}`).Draw(t, fmt.Sprintf("val%d", i))
			obj[key] = val
		}

		raw, err := json.Marshal(obj)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		// Double-check no {{ in generated JSON.
		if strings.Contains(string(raw), "{{") {
			return // skip this case
		}

		result, err := ResolveTemplates(json.RawMessage(raw), nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if string(result) != string(raw) {
			t.Fatalf("expected identity:\n  input:  %s\n  output: %s", raw, result)
		}
	})
}
