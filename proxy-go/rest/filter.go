package rest

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// FilterOp is the comparison operator extracted from a PostgREST query param.
type FilterOp int

const (
	OpEq    FilterOp = iota // eq   → =
	OpNeq                   // neq  → !=
	OpGt                    // gt   → >
	OpGte                   // gte  → >=
	OpLt                    // lt   → <
	OpLte                   // lte  → <=
	OpLike                  // like → LIKE
	OpIlike                 // ilike → ILIKE
	OpIs                    // is   → IS
	OpIn                    // in   → IN (...)
	OpCs                    // cs   → @>  (contains)
	OpCd                    // cd   → <@  (contained by)
	OpFts                   // fts  → @@  (full-text search)
)

// SQLOP returns the SQL operator string for the FilterOp.
func (op FilterOp) SQLOP() string {
	switch op {
	case OpEq:
		return "="
	case OpNeq:
		return "!="
	case OpGt:
		return ">"
	case OpGte:
		return ">="
	case OpLt:
		return "<"
	case OpLte:
		return "<="
	case OpLike:
		return "LIKE"
	case OpIlike:
		return "ILIKE"
	case OpIs:
		return "IS"
	case OpIn:
		return "IN"
	case OpCs:
		return "@>"
	case OpCd:
		return "<@"
	case OpFts:
		return "@@"
	default:
		return "="
	}
}

// Filter represents one WHERE condition parsed from a query parameter.
type Filter struct {
	Column string
	Op     FilterOp
	Value  string
	Negate bool // true when the "not." prefix was present
}

// OrderClause represents one ORDER BY term.
type OrderClause struct {
	Column     string
	Ascending  bool
	NullsFirst *bool // nil = unspecified (database default)
}

// RestQuery holds all parsed URL parameters for a REST request.
type RestQuery struct {
	Select  string        // raw ?select= value (may contain embed syntax)
	Filters []Filter
	Order   []OrderClause
	Limit   *int
	Offset  *int
}

// reservedParams are URL parameters that are NOT treated as column filters.
var reservedParams = map[string]bool{
	"select": true,
	"order":  true,
	"limit":  true,
	"offset": true,
}

// ParseQuery parses URL query parameters into a RestQuery.
//
// PostgREST filter syntax:  ?column=op.value
// Negate:                   ?column=not.op.value
// Order:                    ?order=col.asc,col.desc.nullsfirst
// Pagination:               ?limit=N&offset=M
// Select/embeds:            ?select=col1,col2,rel(*)
func ParseQuery(rawQuery string) (*RestQuery, error) {
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		return nil, fmt.Errorf("parse query: %w", err)
	}

	q := &RestQuery{}

	// ?select
	if s := values.Get("select"); s != "" {
		q.Select = s
	}

	// ?limit / ?offset
	if s := values.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			return nil, fmt.Errorf("invalid limit: %s", s)
		}
		q.Limit = &n
	}
	if s := values.Get("offset"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			return nil, fmt.Errorf("invalid offset: %s", s)
		}
		q.Offset = &n
	}

	// ?order=col.asc,other.desc.nullsfirst
	if s := values.Get("order"); s != "" {
		clauses, err := parseOrderClauses(s)
		if err != nil {
			return nil, err
		}
		q.Order = clauses
	}

	// All other parameters are treated as column filters.
	for key, vals := range values {
		if reservedParams[key] {
			continue
		}
		for _, raw := range vals {
			f, err := parseFilter(key, raw)
			if err != nil {
				return nil, err
			}
			q.Filters = append(q.Filters, f)
		}
	}

	return q, nil
}

// parseFilter converts a single ?col=op.value pair into a Filter.
func parseFilter(col, raw string) (Filter, error) {
	negate := false

	// Strip leading "not." prefix.
	if strings.HasPrefix(raw, "not.") {
		negate = true
		raw = raw[4:]
	}

	// Split into op and value parts (first dot separates them).
	dotIdx := strings.Index(raw, ".")
	if dotIdx < 0 {
		// Bare value with no operator — treat as eq.
		return Filter{Column: col, Op: OpEq, Value: raw, Negate: negate}, nil
	}

	opStr := raw[:dotIdx]
	value := raw[dotIdx+1:]

	op, err := parseOp(opStr)
	if err != nil {
		return Filter{}, fmt.Errorf("unknown operator %q for column %q", opStr, col)
	}

	return Filter{Column: col, Op: op, Value: value, Negate: negate}, nil
}

// parseOp maps a PostgREST operator string to a FilterOp constant.
func parseOp(s string) (FilterOp, error) {
	switch strings.ToLower(s) {
	case "eq":
		return OpEq, nil
	case "neq":
		return OpNeq, nil
	case "gt":
		return OpGt, nil
	case "gte":
		return OpGte, nil
	case "lt":
		return OpLt, nil
	case "lte":
		return OpLte, nil
	case "like":
		return OpLike, nil
	case "ilike":
		return OpIlike, nil
	case "is":
		return OpIs, nil
	case "in":
		return OpIn, nil
	case "cs":
		return OpCs, nil
	case "cd":
		return OpCd, nil
	case "fts":
		return OpFts, nil
	default:
		return 0, fmt.Errorf("unknown operator: %s", s)
	}
}

// parseOrderClauses parses a comma-separated list of order terms.
// Each term has the form: column[.asc|.desc][.nullsfirst|.nullslast]
func parseOrderClauses(s string) ([]OrderClause, error) {
	parts := strings.Split(s, ",")
	out := make([]OrderClause, 0, len(parts))

	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}

		segs := strings.Split(p, ".")
		if len(segs) < 1 {
			return nil, fmt.Errorf("invalid order term: %s", p)
		}

		col := segs[0]
		asc := true // default ascending
		var nullsFirst *bool

		for _, seg := range segs[1:] {
			switch strings.ToLower(seg) {
			case "asc":
				asc = true
			case "desc":
				asc = false
			case "nullsfirst":
				b := true
				nullsFirst = &b
			case "nullslast":
				b := false
				nullsFirst = &b
			}
		}

		out = append(out, OrderClause{
			Column:     col,
			Ascending:  asc,
			NullsFirst: nullsFirst,
		})
	}

	return out, nil
}
