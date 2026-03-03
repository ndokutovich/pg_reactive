package rest

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// EmbedRequest is a parsed embed directive from ?select=*,comments(id,body).
type EmbedRequest struct {
	Relation string         // "comments", "author", etc.
	Columns  []string       // nil or empty means SELECT *
	Children []EmbedRequest // nested embeds
}

// EmbedJoinType distinguishes many-to-one (parent has FK) from one-to-many
// (child has FK pointing back to parent).
type EmbedJoinType int

const (
	// ManyToOne: the parent table has a FK column that points to the target
	// table.  The lateral subquery returns a single JSON object.
	ManyToOne EmbedJoinType = iota

	// OneToMany: the target table has a FK column that points back to the
	// parent table.  The lateral subquery returns a JSON array.
	OneToMany
)

// ResolvedEmbed is an EmbedRequest with FK relationship resolved from the
// catalog.
type ResolvedEmbed struct {
	RelationName string
	TargetTable  *TableMeta
	JoinType     EmbedJoinType
	ParentCols   []string // columns in the parent table used for the join
	TargetCols   []string // columns in the target table used for the join
	Columns      []string // explicit columns requested (nil → *)
	Children     []ResolvedEmbed
}

// maxEmbedDepth is the maximum nesting level for embedded resources.
const maxEmbedDepth = 3

// ParseEmbeds splits a ?select= value into plain column names and embed
// requests.
//
// Examples:
//
//	"*"                           → (["*"], [])
//	"id,name,comments(id,body)"   → (["id","name"], [{Relation:"comments", Columns:["id","body"]}])
//	"*,author(name,posts(title))" → (["*"], [{Relation:"author", Children:[{Relation:"posts"}]}])
func ParseEmbeds(selectStr string) ([]string, []EmbedRequest) {
	if selectStr == "" {
		return []string{"*"}, nil
	}

	var plainCols []string
	var embeds []EmbedRequest

	// Split at commas that are NOT inside parentheses.
	fields := splitTopLevel(selectStr)
	for _, f := range fields {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		parenIdx := strings.Index(f, "(")
		if parenIdx < 0 {
			// Plain column or "*".
			plainCols = append(plainCols, f)
			continue
		}
		// Embed: name(...)
		relation := strings.TrimSpace(f[:parenIdx])
		inner := f[parenIdx+1:]
		// Strip trailing ")"
		if strings.HasSuffix(inner, ")") {
			inner = inner[:len(inner)-1]
		}
		req := EmbedRequest{Relation: relation}
		innerCols, innerEmbeds := ParseEmbeds(inner)
		req.Columns = innerCols
		req.Children = innerEmbeds
		embeds = append(embeds, req)
	}

	if len(plainCols) == 0 && len(embeds) > 0 {
		// No explicit plain cols — default to all.
		plainCols = []string{"*"}
	}

	return plainCols, embeds
}

// splitTopLevel splits s by commas at parenthesis depth 0.
func splitTopLevel(s string) []string {
	var parts []string
	depth := 0
	start := 0
	for i, ch := range s {
		switch ch {
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, s[start:i])
				start = i + 1
			}
		}
	}
	parts = append(parts, s[start:])
	return parts
}

// ResolveEmbed resolves an EmbedRequest to a ResolvedEmbed by searching the
// catalog for a FK relationship between parentTable and req.Relation.
//
// It tries:
//  1. parentTable has a FK to the target table (ManyToOne)
//  2. target table has a FK back to parentTable (OneToMany)
func ResolveEmbed(catalog *Catalog, parentTable *TableMeta, req EmbedRequest, depth int) (*ResolvedEmbed, error) {
	if depth >= maxEmbedDepth {
		return nil, fmt.Errorf("embed depth limit (%d) exceeded for %q", maxEmbedDepth, req.Relation)
	}

	// Try to find the target table by bare name in any schema.
	target := catalog.GetTable(req.Relation)
	if target == nil {
		return nil, fmt.Errorf("embed: relation %q not found in catalog", req.Relation)
	}

	parentKey := parentTable.Schema + "." + parentTable.Name
	targetKey := target.Schema + "." + target.Name

	// 1. ManyToOne: parentTable has a FK pointing at targetTable.
	for _, fk := range parentTable.ForeignKeys {
		if fk.ReferencedTable == targetKey {
			if err := validateEmbedColumns(target, req.Columns); err != nil {
				return nil, err
			}
			re := &ResolvedEmbed{
				RelationName: req.Relation,
				TargetTable:  target,
				JoinType:     ManyToOne,
				ParentCols:   fk.Columns,
				TargetCols:   fk.ReferencedColumns,
				Columns:      req.Columns,
			}
			if err := resolveChildren(catalog, re, req.Children, depth); err != nil {
				return nil, err
			}
			return re, nil
		}
	}

	// 2. OneToMany: targetTable has a FK pointing at parentTable.
	for _, fk := range target.ForeignKeys {
		if fk.ReferencedTable == parentKey {
			if err := validateEmbedColumns(target, req.Columns); err != nil {
				return nil, err
			}
			re := &ResolvedEmbed{
				RelationName: req.Relation,
				TargetTable:  target,
				JoinType:     OneToMany,
				ParentCols:   fk.ReferencedColumns,
				TargetCols:   fk.Columns,
				Columns:      req.Columns,
			}
			if err := resolveChildren(catalog, re, req.Children, depth); err != nil {
				return nil, err
			}
			return re, nil
		}
	}

	return nil, fmt.Errorf("embed: no FK relationship found between %q and %q", parentTable.Name, req.Relation)
}

// validateEmbedColumns checks that all user-requested columns exist in the
// target table.  Columns named "*" are always allowed.
func validateEmbedColumns(target *TableMeta, columns []string) error {
	if len(columns) == 0 {
		return nil
	}
	colSet := target.columnSet()
	for _, c := range columns {
		if c == "*" {
			continue
		}
		if _, ok := colSet[c]; !ok {
			return fmt.Errorf("column %q not found in table %q", c, target.Name)
		}
	}
	return nil
}

func resolveChildren(catalog *Catalog, parent *ResolvedEmbed, children []EmbedRequest, depth int) error {
	for _, child := range children {
		rc, err := ResolveEmbed(catalog, parent.TargetTable, child, depth+1)
		if err != nil {
			return err
		}
		parent.Children = append(parent.Children, *rc)
	}
	return nil
}

// ExecuteSelectWithEmbeds executes a SELECT query with FK-based LATERAL embed
// subqueries and returns the result as a JSON array.
func ExecuteSelectWithEmbeds(
	ctx context.Context,
	tx pgx.Tx,
	builtSelect *BuiltQuery,
	parent *TableMeta,
	embeds []ResolvedEmbed,
	plainCols []string,
) (json.RawMessage, error) {
	// Build the final SQL using a CTE for the base query plus LATERAL joins.
	sql, err := buildEmbedSQL(builtSelect, parent, embeds, plainCols)
	if err != nil {
		return nil, err
	}

	var result json.RawMessage
	row := tx.QueryRow(ctx, sql, builtSelect.Params...)
	if err := row.Scan(&result); err != nil {
		return nil, err
	}
	return result, nil
}

// collectJoinCols returns FK join columns from ManyToOne embeds that are not
// already present in the user-requested plain column list.  These columns must
// be added to the base CTE so the LATERAL JOIN conditions can reference them,
// but they should not appear in the final response.
func collectJoinCols(embeds []ResolvedEmbed, plainCols []string) []string {
	// SELECT * already fetches everything — no extras needed.
	for _, c := range plainCols {
		if c == "*" {
			return nil
		}
	}
	colSet := make(map[string]bool, len(plainCols))
	for _, c := range plainCols {
		colSet[c] = true
	}
	var extra []string
	seen := make(map[string]bool)
	for _, em := range embeds {
		if em.JoinType == ManyToOne {
			for _, col := range em.ParentCols {
				if !colSet[col] && !seen[col] {
					extra = append(extra, col)
					seen[col] = true
				}
			}
		}
	}
	return extra
}

// buildEmbedSQL constructs the full SQL with WITH … LATERAL … structure.
func buildEmbedSQL(builtSelect *BuiltQuery, parent *TableMeta, embeds []ResolvedEmbed, plainCols []string) (string, error) {
	var sb strings.Builder

	// CTE: base query.
	sb.WriteString("WITH base AS (")
	sb.WriteString(builtSelect.SQL)
	sb.WriteString(")\n")

	// Outer SELECT with LATERAL joins.
	// When the user requested explicit columns (not *), project only those
	// columns from base — not any extra FK join columns that were added to the
	// base CTE to support ManyToOne lateral conditions.
	sb.WriteString("SELECT COALESCE(json_agg(row_to_json(combined)), '[]'::json) AS data FROM (\n")

	isSelectStar := len(plainCols) == 0 || (len(plainCols) == 1 && plainCols[0] == "*")
	if isSelectStar {
		sb.WriteString("  SELECT base.*")
	} else {
		var outerCols strings.Builder
		for i, c := range plainCols {
			if i > 0 {
				outerCols.WriteString(", ")
			}
			if c == "*" {
				outerCols.WriteString("base.*")
			} else {
				outerCols.WriteString("base." + QuoteIdent(c))
			}
		}
		sb.WriteString("  SELECT " + outerCols.String())
	}

	laterals := make([]string, 0, len(embeds))
	for i, em := range embeds {
		alias := fmt.Sprintf("_e%d", i)
		lateralSQL, err := buildLateralSubquery(em, alias, 0)
		if err != nil {
			return "", err
		}
		sb.WriteString(fmt.Sprintf(", %s.data AS %s", alias, QuoteIdent(em.RelationName)))
		laterals = append(laterals, fmt.Sprintf("  LEFT JOIN LATERAL (%s) %s ON true", lateralSQL, alias))
	}

	sb.WriteString("\n  FROM base\n")
	for _, lat := range laterals {
		sb.WriteString(lat)
		sb.WriteString("\n")
	}

	sb.WriteString(") combined")

	return sb.String(), nil
}

// buildLateralSubquery builds the SQL for one LATERAL subquery, handling nested
// embeds recursively.
func buildLateralSubquery(em ResolvedEmbed, alias string, depth int) (string, error) {
	targetQ := qualifiedTable(em.TargetTable)

	// Column list for the inner SELECT.
	innerCols := buildEmbedColList(em.TargetTable, em.Columns)

	// Resolve any nested embeds.
	var nestedParts []string
	var nestedLaterals []string
	for i, child := range em.Children {
		childAlias := fmt.Sprintf("%s_c%d", alias, i)
		childSQL, err := buildLateralSubquery(child, childAlias, depth+1)
		if err != nil {
			return "", err
		}
		nestedParts = append(nestedParts, fmt.Sprintf("%s.data AS %s", childAlias, QuoteIdent(child.RelationName)))
		nestedLaterals = append(nestedLaterals, fmt.Sprintf("LEFT JOIN LATERAL (%s) %s ON true", childSQL, childAlias))
	}

	// Build the WHERE condition: for each join column pair.
	whereParts := make([]string, 0, len(em.TargetCols))
	for j := range em.TargetCols {
		whereParts = append(whereParts,
			fmt.Sprintf("%s.%s = base.%s",
				QuoteIdent("_inner"),
				QuoteIdent(em.TargetCols[j]),
				QuoteIdent(em.ParentCols[j]),
			),
		)
	}
	whereSQL := strings.Join(whereParts, " AND ")

	// Build the inner SELECT (may include nested lateral columns).
	var innerSB strings.Builder
	innerSB.WriteString("SELECT ")
	if innerCols == "*" {
		innerSB.WriteString(QuoteIdent("_inner") + ".*")
	} else {
		// Prefix each column with the inner alias.
		cols := strings.Split(innerCols, ", ")
		prefixed := make([]string, 0, len(cols))
		for _, c := range cols {
			prefixed = append(prefixed, QuoteIdent("_inner")+"."+c)
		}
		innerSB.WriteString(strings.Join(prefixed, ", "))
	}
	for _, np := range nestedParts {
		innerSB.WriteString(", ")
		innerSB.WriteString(np)
	}
	innerSB.WriteString(fmt.Sprintf(" FROM %s AS %s", targetQ, QuoteIdent("_inner")))
	for _, nl := range nestedLaterals {
		innerSB.WriteString(" ")
		innerSB.WriteString(nl)
	}
	innerSB.WriteString(fmt.Sprintf(" WHERE %s", whereSQL))

	innerQuery := innerSB.String()

	var sb strings.Builder
	if em.JoinType == ManyToOne {
		// Single object: row_to_json + LIMIT 1.
		sb.WriteString("SELECT row_to_json(t) AS data FROM (")
		sb.WriteString(innerQuery)
		sb.WriteString(" LIMIT 1) t")
	} else {
		// Array: json_agg.
		sb.WriteString("SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) AS data FROM (")
		sb.WriteString(innerQuery)
		sb.WriteString(") t")
	}

	return sb.String(), nil
}

// buildEmbedColList returns the column list for an embedded SELECT.
// Returns "*" for the table alias when no explicit columns are requested.
func buildEmbedColList(tm *TableMeta, cols []string) string {
	if len(cols) == 0 {
		return "*"
	}
	for _, c := range cols {
		if c == "*" {
			return "*"
		}
	}
	colSet := tm.columnSet()
	parts := make([]string, 0, len(cols))
	for _, c := range cols {
		if _, ok := colSet[c]; ok {
			parts = append(parts, QuoteIdent(c))
		}
	}
	if len(parts) == 0 {
		return "*"
	}
	return strings.Join(parts, ", ")
}
