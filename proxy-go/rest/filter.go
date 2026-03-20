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
	OpOv                    // ov   → &&  (overlap)
	OpSl                    // sl   → <<  (strictly left)
	OpSr                    // sr   → >>  (strictly right)
	OpNxl                   // nxl  → &<  (not extends left)
	OpNxr                   // nxr  → &>  (not extends right)
	OpAdj                   // adj  → -|- (adjacent)
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
	case OpOv:
		return "&&"
	case OpSl:
		return "<<"
	case OpSr:
		return ">>"
	case OpNxl:
		return "&<"
	case OpNxr:
		return "&>"
	case OpAdj:
		return "-|-"
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

// LogicalGroup represents a group of filters combined with OR or AND.
// Parsed from PostgREST ?or=(col.op.val,col.op.val) or ?and=(col.op.val,col.op.val).
type LogicalGroup struct {
	Operator string   // "or" or "and"
	Filters  []Filter
}

// OrderClause represents one ORDER BY term.
type OrderClause struct {
	Column     string
	Ascending  bool
	NullsFirst *bool // nil = unspecified (database default)
}

// RestQuery holds all parsed URL parameters for a REST request.
type RestQuery struct {
	Select        string         // raw ?select= value (may contain embed syntax)
	Filters       []Filter
	LogicalGroups []LogicalGroup // or/and combinators
	Order         []OrderClause
	Limit         *int
	Offset        *int
	Count         string // "exact", "planned", "estimated", or "" (no count)
}

// reservedParams are URL parameters that are NOT treated as column filters.
var reservedParams = map[string]bool{
	"select": true,
	"order":  true,
	"limit":  true,
	"offset": true,
	"or":     true,
	"and":    true,
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

	// ?or=(...) / ?and=(...)
	for _, logOp := range []string{"or", "and"} {
		for _, raw := range values[logOp] {
			group, err := parseLogicalGroup(logOp, raw)
			if err != nil {
				return nil, err
			}
			q.LogicalGroups = append(q.LogicalGroups, group)
		}
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
	case "ov":
		return OpOv, nil
	case "sl":
		return OpSl, nil
	case "sr":
		return OpSr, nil
	case "nxl":
		return OpNxl, nil
	case "nxr":
		return OpNxr, nil
	case "adj":
		return OpAdj, nil
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

// parseLogicalGroup parses a PostgREST logical combinator value such as
// "(col1.eq.val1,col2.in.(a,b,c))" into a LogicalGroup.
func parseLogicalGroup(operator, raw string) (LogicalGroup, error) {
	// Strip outer parentheses.
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "(") && strings.HasSuffix(raw, ")") {
		raw = raw[1 : len(raw)-1]
	}

	segments := splitLogicalExprs(raw)
	if len(segments) == 0 {
		return LogicalGroup{}, fmt.Errorf("empty %s group", operator)
	}

	filters := make([]Filter, 0, len(segments))
	for _, seg := range segments {
		f, err := parseLogicalFilter(seg)
		if err != nil {
			return LogicalGroup{}, fmt.Errorf("%s group: %w", operator, err)
		}
		filters = append(filters, f)
	}

	return LogicalGroup{Operator: operator, Filters: filters}, nil
}

// parseLogicalFilter parses a single "col.op.val" segment from inside a
// logical group expression.  It splits on the first dot to extract the column
// name, then delegates to parseFilter for operator+value parsing.
func parseLogicalFilter(raw string) (Filter, error) {
	raw = strings.TrimSpace(raw)

	dotIdx := strings.Index(raw, ".")
	if dotIdx < 0 {
		return Filter{}, fmt.Errorf("invalid logical filter segment: %q (expected col.op.val)", raw)
	}
	col := raw[:dotIdx]
	rest := raw[dotIdx+1:]

	return parseFilter(col, rest)
}

// splitLogicalExprs splits a comma-separated string while respecting
// parenthesized sub-expressions.  For example:
//
//	"id.in.(1,2,3),name.eq.Alice" -> ["id.in.(1,2,3)", "name.eq.Alice"]
func splitLogicalExprs(s string) []string {
	var result []string
	depth := 0
	start := 0

	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		case ',':
			if depth == 0 {
				seg := strings.TrimSpace(s[start:i])
				if seg != "" {
					result = append(result, seg)
				}
				start = i + 1
			}
		}
	}

	// Last segment.
	if start < len(s) {
		seg := strings.TrimSpace(s[start:])
		if seg != "" {
			result = append(result, seg)
		}
	}

	return result
}
