package rest

import (
	"fmt"
	"regexp"
	"strings"
)

// BuiltQuery holds a parameterised SQL statement and its bound arguments.
type BuiltQuery struct {
	SQL    string
	Params []any
}

// QuoteIdent wraps a PostgreSQL identifier in double-quotes, escaping any
// internal double-quotes by doubling them.
func QuoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// safePGTypeRe matches valid PostgreSQL type strings: alphanumeric, underscore,
// spaces, brackets, parentheses (for array/precision), dots, and commas.
var safePGTypeRe = regexp.MustCompile(`^[a-zA-Z0-9_\s\[\]\(\).,]+$`)

// SafePGType returns typ if it looks like a valid PG type; otherwise "text".
// Used to safely inline type names into SQL casts.
func SafePGType(typ string) string {
	if safePGTypeRe.MatchString(typ) {
		return typ
	}
	return "text"
}

// qualifiedTable returns "schema"."name" quoted.
func qualifiedTable(tm *TableMeta) string {
	return QuoteIdent(tm.Schema) + "." + QuoteIdent(tm.Name)
}

// BuildSelect builds a SELECT query from the table metadata, RestQuery, and a
// list of explicit column names.  If selectCols is empty or contains only "*"
// the query selects all columns.
//
// Embed expansion is handled separately in embed.go; this function always
// returns a plain SELECT.
func BuildSelect(table *TableMeta, q *RestQuery, selectCols []string) (*BuiltQuery, error) {
	var sb strings.Builder
	var params []any

	// Column list
	colSQL := buildSelectList(table, selectCols)
	sb.WriteString("SELECT ")
	sb.WriteString(colSQL)
	sb.WriteString(" FROM ")
	sb.WriteString(qualifiedTable(table))

	// WHERE clause
	if len(q.Filters) > 0 {
		where, wParams, _, err := buildWhereClause(q.Filters, table, 1)
		if err != nil {
			return nil, err
		}
		sb.WriteString(" WHERE ")
		sb.WriteString(where)
		params = append(params, wParams...)
	}

	// ORDER BY
	if len(q.Order) > 0 {
		orderSQL, err := buildOrderClause(q.Order, table)
		if err != nil {
			return nil, err
		}
		sb.WriteString(" ORDER BY ")
		sb.WriteString(orderSQL)
	}

	// LIMIT / OFFSET
	if q.Limit != nil {
		sb.WriteString(fmt.Sprintf(" LIMIT %d", *q.Limit))
	}
	if q.Offset != nil {
		sb.WriteString(fmt.Sprintf(" OFFSET %d", *q.Offset))
	}

	return &BuiltQuery{SQL: sb.String(), Params: params}, nil
}

// BuildInsert builds a parameterised INSERT ... RETURNING * wrapped in a CTE
// so the caller can wrap it with json_agg.
func BuildInsert(table *TableMeta, body map[string]any) (*BuiltQuery, error) {
	if len(body) == 0 {
		return nil, fmt.Errorf("insert: empty body")
	}

	cols := make([]string, 0, len(body))
	for k := range body {
		cols = append(cols, k)
	}
	// Stable ordering for predictable SQL (and tests).
	sortStrings(cols)

	colSet := table.columnSet()
	var colSQL, valSQL strings.Builder
	params := make([]any, 0, len(cols))
	idx := 1

	for i, c := range cols {
		if _, ok := colSet[c]; !ok {
			return nil, fmt.Errorf("insert: unknown column %q", c)
		}
		if i > 0 {
			colSQL.WriteString(", ")
			valSQL.WriteString(", ")
		}
		colSQL.WriteString(QuoteIdent(c))
		typ := SafePGType(table.columnType(c))
		valSQL.WriteString(fmt.Sprintf("$%d::%s", idx, typ))
		params = append(params, body[c])
		idx++
	}

	sql := fmt.Sprintf(
		`WITH result AS (INSERT INTO %s (%s) VALUES (%s) RETURNING *)`+
			` SELECT COALESCE(json_agg(row_to_json(result)), '[]'::json) AS data FROM result`,
		qualifiedTable(table), colSQL.String(), valSQL.String(),
	)
	return &BuiltQuery{SQL: sql, Params: params}, nil
}

// BuildUpdate builds a parameterised UPDATE … SET … WHERE … RETURNING * with
// json_agg wrapping.  At least one filter is required.
func BuildUpdate(table *TableMeta, body map[string]any, q *RestQuery) (*BuiltQuery, error) {
	if len(body) == 0 {
		return nil, fmt.Errorf("update: empty body")
	}
	if len(q.Filters) == 0 {
		return nil, fmt.Errorf("update: at least one filter is required")
	}

	cols := make([]string, 0, len(body))
	for k := range body {
		cols = append(cols, k)
	}
	sortStrings(cols)

	colSet := table.columnSet()
	var setSQL strings.Builder
	params := make([]any, 0, len(cols))
	idx := 1

	for i, c := range cols {
		if _, ok := colSet[c]; !ok {
			return nil, fmt.Errorf("update: unknown column %q", c)
		}
		if i > 0 {
			setSQL.WriteString(", ")
		}
		typ := SafePGType(table.columnType(c))
		setSQL.WriteString(fmt.Sprintf("%s = $%d::%s", QuoteIdent(c), idx, typ))
		params = append(params, body[c])
		idx++
	}

	where, wParams, _, err := buildWhereClause(q.Filters, table, idx)
	if err != nil {
		return nil, err
	}
	params = append(params, wParams...)

	sql := fmt.Sprintf(
		`WITH result AS (UPDATE %s SET %s WHERE %s RETURNING *)`+
			` SELECT COALESCE(json_agg(row_to_json(result)), '[]'::json) AS data FROM result`,
		qualifiedTable(table), setSQL.String(), where,
	)
	return &BuiltQuery{SQL: sql, Params: params}, nil
}

// BuildDelete builds a parameterised DELETE … WHERE … RETURNING * with
// json_agg wrapping.  At least one filter is required.
func BuildDelete(table *TableMeta, q *RestQuery) (*BuiltQuery, error) {
	if len(q.Filters) == 0 {
		return nil, fmt.Errorf("delete: at least one filter is required")
	}

	where, params, _, err := buildWhereClause(q.Filters, table, 1)
	if err != nil {
		return nil, err
	}

	sql := fmt.Sprintf(
		`WITH result AS (DELETE FROM %s WHERE %s RETURNING *)`+
			` SELECT COALESCE(json_agg(row_to_json(result)), '[]'::json) AS data FROM result`,
		qualifiedTable(table), where,
	)
	return &BuiltQuery{SQL: sql, Params: params}, nil
}

// buildWhereClause produces the SQL fragment for a WHERE clause and the
// corresponding parameter slice.  startIdx is the first $N index to use.
// Returns (sql, params, nextIdx, error).
func buildWhereClause(filters []Filter, table *TableMeta, startIdx int) (string, []any, int, error) {
	colSet := table.columnSet()
	parts := make([]string, 0, len(filters))
	params := make([]any, 0, len(filters))
	idx := startIdx

	for _, f := range filters {
		// Column injection prevention: validate against known columns.
		if _, ok := colSet[f.Column]; !ok {
			return "", nil, idx, fmt.Errorf("unknown column %q", f.Column)
		}
		colSQL := QuoteIdent(f.Column)
		typ := SafePGType(table.columnType(f.Column))

		var cond string

		switch f.Op {
		case OpIs:
			// IS NULL / IS TRUE / IS FALSE / IS UNKNOWN — no parameter.
			val := strings.ToUpper(f.Value)
			switch val {
			case "NULL", "TRUE", "FALSE", "UNKNOWN":
				// safe literal
			default:
				return "", nil, idx, fmt.Errorf("invalid IS value %q", f.Value)
			}
			cond = fmt.Sprintf("%s IS %s", colSQL, val)

		case OpIn:
			// Value format: (a,b,c) or a,b,c
			raw := strings.TrimSpace(f.Value)
			raw = strings.TrimPrefix(raw, "(")
			raw = strings.TrimSuffix(raw, ")")
			items := strings.Split(raw, ",")
			if len(items) == 0 {
				return "", nil, idx, fmt.Errorf("empty IN list for column %q", f.Column)
			}
			placeholders := make([]string, 0, len(items))
			for _, item := range items {
				item = strings.TrimSpace(item)
				placeholders = append(placeholders, fmt.Sprintf("$%d::%s", idx, typ))
				params = append(params, item)
				idx++
			}
			cond = fmt.Sprintf("%s IN (%s)", colSQL, strings.Join(placeholders, ", "))

		case OpLike, OpIlike:
			// Convert PostgREST wildcard (*) to SQL wildcard (%).
			val := strings.ReplaceAll(f.Value, "*", "%")
			cond = fmt.Sprintf("%s %s $%d", colSQL, f.Op.SQLOP(), idx)
			params = append(params, val)
			idx++

		default:
			cond = fmt.Sprintf("%s %s $%d::%s", colSQL, f.Op.SQLOP(), idx, typ)
			params = append(params, f.Value)
			idx++
		}

		if f.Negate {
			cond = "NOT (" + cond + ")"
		}
		parts = append(parts, cond)
	}

	return strings.Join(parts, " AND "), params, idx, nil
}

// buildSelectList returns the column list for a SELECT.  "*" or an empty
// slice produces a plain SELECT *.
func buildSelectList(table *TableMeta, cols []string) string {
	if len(cols) == 0 {
		return "*"
	}
	// Check for wildcard.
	for _, c := range cols {
		if c == "*" {
			return "*"
		}
	}
	colSet := table.columnSet()
	parts := make([]string, 0, len(cols))
	for _, c := range cols {
		if _, ok := colSet[c]; ok {
			parts = append(parts, QuoteIdent(c))
		}
		// Silently skip unknown columns (embed syntax may include relation names).
	}
	if len(parts) == 0 {
		return "*"
	}
	return strings.Join(parts, ", ")
}

// buildOrderClause produces the SQL ORDER BY fragment.
func buildOrderClause(order []OrderClause, table *TableMeta) (string, error) {
	colSet := table.columnSet()
	parts := make([]string, 0, len(order))

	for _, o := range order {
		if _, ok := colSet[o.Column]; !ok {
			return "", fmt.Errorf("unknown order column %q", o.Column)
		}
		dir := "ASC"
		if !o.Ascending {
			dir = "DESC"
		}
		term := QuoteIdent(o.Column) + " " + dir
		if o.NullsFirst != nil {
			if *o.NullsFirst {
				term += " NULLS FIRST"
			} else {
				term += " NULLS LAST"
			}
		}
		parts = append(parts, term)
	}
	return strings.Join(parts, ", "), nil
}

// sortStrings sorts a string slice in-place (stdlib sort is fine here; we
// avoid importing sort package by writing a simple insertion sort for small
// slices common in REST bodies). For correctness we use stdlib sort.
func sortStrings(s []string) {
	// Simple insertion sort — bodies are rarely > 20 columns.
	for i := 1; i < len(s); i++ {
		key := s[i]
		j := i - 1
		for j >= 0 && s[j] > key {
			s[j+1] = s[j]
			j--
		}
		s[j+1] = key
	}
}
