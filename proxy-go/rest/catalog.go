package rest

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Catalog is a thread-safe, in-memory cache of pg_catalog table/view metadata.
// Call Refresh to (re)load from the database. GetTable and ListTables are safe
// for concurrent read access at any time.
type Catalog struct {
	mu     sync.RWMutex
	tables map[string]*TableMeta // "schema.name" → *TableMeta
}

// TableMeta describes one user-visible table, view, materialised view, or
// partitioned table.
type TableMeta struct {
	Schema      string
	Name        string
	Columns     []ColumnMeta
	PrimaryKeys []string // column names that form the primary key
	ForeignKeys []ForeignKey
}

// ColumnMeta describes a single column.
type ColumnMeta struct {
	Name       string
	PGType     string
	IsNullable bool
	HasDefault bool
	Ordinal    int
}

// ForeignKey describes one FOREIGN KEY constraint on the table.
type ForeignKey struct {
	Columns           []string // columns in this table
	ReferencedTable   string   // "schema.name" of the referenced table
	ReferencedColumns []string // columns in the referenced table
	ConstraintName    string
}

// NewCatalog returns an empty, ready-to-use Catalog.
func NewCatalog() *Catalog {
	return &Catalog{tables: make(map[string]*TableMeta)}
}

// Refresh loads (or reloads) table metadata from pg_catalog using the supplied
// connection pool.  It is safe to call while handlers are running; the swap is
// atomic.
func (c *Catalog) Refresh(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("catalog refresh: acquire connection: %w", err)
	}
	defer conn.Release()

	tables := make(map[string]*TableMeta)

	// ── 1. Columns ────────────────────────────────────────────────────────
	const colQ = `
SELECT
    n.nspname   AS schema,
    c.relname   AS table_name,
    a.attname   AS column_name,
    t.typname   AS type_name,
    NOT a.attnotnull AS is_nullable,
    pg_get_expr(d.adbin, d.adrelid) IS NOT NULL AS has_default,
    a.attnum    AS ordinal
FROM pg_attribute a
JOIN pg_class     c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type      t ON t.oid = a.atttypid
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attnum > 0
  AND NOT a.attisdropped
  AND c.relkind IN ('r','v','m','p')
  AND n.nspname NOT IN ('pg_catalog','information_schema','pgr','pgstack')
ORDER BY n.nspname, c.relname, a.attnum`

	rows, err := conn.Query(ctx, colQ)
	if err != nil {
		return fmt.Errorf("catalog refresh: columns query: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var schema, tableName, colName, typName string
		var isNullable, hasDefault bool
		var ordinal int

		if err := rows.Scan(&schema, &tableName, &colName, &typName, &isNullable, &hasDefault, &ordinal); err != nil {
			return fmt.Errorf("catalog refresh: scan column: %w", err)
		}

		key := schema + "." + tableName
		tm, ok := tables[key]
		if !ok {
			tm = &TableMeta{Schema: schema, Name: tableName}
			tables[key] = tm
		}
		tm.Columns = append(tm.Columns, ColumnMeta{
			Name:       colName,
			PGType:     typName,
			IsNullable: isNullable,
			HasDefault: hasDefault,
			Ordinal:    ordinal,
		})
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("catalog refresh: columns rows: %w", err)
	}

	// ── 2. Primary keys ───────────────────────────────────────────────────
	const pkQ = `
SELECT
    n.nspname   AS schema,
    c.relname   AS table_name,
    a.attname   AS column_name
FROM pg_index     i
JOIN pg_class     c ON c.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
WHERE i.indisprimary
  AND n.nspname NOT IN ('pg_catalog','information_schema','pgr','pgstack')`

	pkRows, err := conn.Query(ctx, pkQ)
	if err != nil {
		return fmt.Errorf("catalog refresh: pk query: %w", err)
	}
	defer pkRows.Close()

	for pkRows.Next() {
		var schema, tableName, colName string
		if err := pkRows.Scan(&schema, &tableName, &colName); err != nil {
			return fmt.Errorf("catalog refresh: scan pk: %w", err)
		}
		key := schema + "." + tableName
		if tm, ok := tables[key]; ok {
			tm.PrimaryKeys = append(tm.PrimaryKeys, colName)
		}
	}
	if err := pkRows.Err(); err != nil {
		return fmt.Errorf("catalog refresh: pk rows: %w", err)
	}

	// ── 3. Foreign keys ───────────────────────────────────────────────────
	const fkQ = `
SELECT
    n.nspname   AS schema,
    c.relname   AS table_name,
    r.conname   AS constraint_name,
    pg_get_constraintdef(r.oid) AS condef
FROM pg_constraint r
JOIN pg_class      c ON c.oid = r.conrelid
JOIN pg_namespace  n ON n.oid = c.relnamespace
WHERE r.contype = 'f'
  AND n.nspname NOT IN ('pg_catalog','information_schema','pgr','pgstack')`

	fkRows, err := conn.Query(ctx, fkQ)
	if err != nil {
		return fmt.Errorf("catalog refresh: fk query: %w", err)
	}
	defer fkRows.Close()

	for fkRows.Next() {
		var schema, tableName, constraintName, condef string
		if err := fkRows.Scan(&schema, &tableName, &constraintName, &condef); err != nil {
			return fmt.Errorf("catalog refresh: scan fk: %w", err)
		}
		fk, ok := parseFKDef(condef, constraintName)
		if !ok {
			continue
		}
		// Qualify the referenced table — if it has no schema prefix assume public.
		if !strings.Contains(fk.ReferencedTable, ".") {
			fk.ReferencedTable = "public." + fk.ReferencedTable
		}
		key := schema + "." + tableName
		if tm, ok := tables[key]; ok {
			tm.ForeignKeys = append(tm.ForeignKeys, fk)
		}
	}
	if err := fkRows.Err(); err != nil {
		return fmt.Errorf("catalog refresh: fk rows: %w", err)
	}

	c.mu.Lock()
	c.tables = tables
	c.mu.Unlock()
	return nil
}

// fkRe parses the output of pg_get_constraintdef for a FOREIGN KEY:
// FOREIGN KEY (col1, col2) REFERENCES other_schema.other_table(ref1, ref2)
var fkRe = regexp.MustCompile(
	`(?i)FOREIGN KEY \(([^)]+)\)\s+REFERENCES\s+(\S+)\s*\(([^)]+)\)`,
)

func parseFKDef(condef, constraintName string) (ForeignKey, bool) {
	m := fkRe.FindStringSubmatch(condef)
	if m == nil {
		return ForeignKey{}, false
	}
	cols := splitAndTrim(m[1])
	refTable := strings.Trim(m[2], `"`)
	refCols := splitAndTrim(m[3])
	return ForeignKey{
		Columns:           cols,
		ReferencedTable:   refTable,
		ReferencedColumns: refCols,
		ConstraintName:    constraintName,
	}, true
}

func splitAndTrim(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		p = strings.Trim(p, `"`)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// GetTable looks up a table by bare name ("users"), "public.users", or
// "schema.name".  Returns nil if not found.
func (c *Catalog) GetTable(name string) *TableMeta {
	c.mu.RLock()
	defer c.mu.RUnlock()

	// Direct "schema.name" lookup.
	if tm, ok := c.tables[name]; ok {
		return tm
	}
	// Bare name — try public schema.
	if !strings.Contains(name, ".") {
		if tm, ok := c.tables["public."+name]; ok {
			return tm
		}
	}
	return nil
}

// ListTables returns all tables in the given schema.  If schema is empty, all
// tables across every schema are returned.
func (c *Catalog) ListTables(schema string) []*TableMeta {
	c.mu.RLock()
	defer c.mu.RUnlock()

	var out []*TableMeta
	if schema == "" {
		// Return everything.
		for _, tm := range c.tables {
			out = append(out, tm)
		}
		return out
	}

	prefix := schema + "."
	for k, tm := range c.tables {
		if strings.HasPrefix(k, prefix) {
			out = append(out, tm)
		}
	}
	return out
}

// columnSet returns a set of column names for fast lookup.
func (tm *TableMeta) columnSet() map[string]struct{} {
	s := make(map[string]struct{}, len(tm.Columns))
	for _, c := range tm.Columns {
		s[c.Name] = struct{}{}
	}
	return s
}

// columnType returns the PG type name for the named column, or "text" if
// unknown.
func (tm *TableMeta) columnType(name string) string {
	for _, c := range tm.Columns {
		if c.Name == name {
			return c.PGType
		}
	}
	return "text"
}
