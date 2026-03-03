use std::collections::HashMap;
use std::sync::Arc;

use sqlx::{PgPool, Row};
use tokio::sync::RwLock;
use tracing::info;

/// Cached database catalog (tables, columns, PKs, FKs).
#[derive(Clone)]
pub struct Catalog {
    inner: Arc<RwLock<CatalogInner>>,
}

#[derive(Default)]
struct CatalogInner {
    /// schema.table -> TableMeta
    tables: HashMap<String, TableMeta>,
}

#[derive(Debug, Clone)]
pub struct TableMeta {
    pub schema: String,
    pub name: String,
    pub columns: Vec<ColumnMeta>,
    pub primary_keys: Vec<String>,
    pub foreign_keys: Vec<ForeignKey>,
}

#[derive(Debug, Clone)]
pub struct ColumnMeta {
    pub name: String,
    pub pg_type: String,
}

#[derive(Debug, Clone)]
pub struct ForeignKey {
    /// Column(s) in this table
    pub columns: Vec<String>,
    /// Referenced schema.table
    pub referenced_table: String,
    /// Referenced column(s)
    pub referenced_columns: Vec<String>,
}

impl Catalog {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(CatalogInner::default())),
        }
    }

    /// Load or refresh catalog from pg_catalog.
    pub async fn refresh(&self, pool: &PgPool) -> Result<(), sqlx::Error> {
        let tables = load_tables(pool).await?;
        let mut inner = self.inner.write().await;
        inner.tables = tables;
        info!("catalog refreshed: {} tables loaded", inner.tables.len());
        Ok(())
    }

    /// Look up a table by name. Tries "public.{name}" first, then "{name}" as-is.
    pub async fn get_table(&self, name: &str) -> Option<TableMeta> {
        let inner = self.inner.read().await;
        // Try qualified name first
        if let Some(t) = inner.tables.get(name) {
            return Some(t.clone());
        }
        // Try public schema
        let qualified = format!("public.{name}");
        inner.tables.get(&qualified).cloned()
    }

}

async fn load_tables(pool: &PgPool) -> Result<HashMap<String, TableMeta>, sqlx::Error> {
    // Load columns for all user tables
    let col_rows = sqlx::query(
        "SELECT
            n.nspname AS schema_name,
            c.relname AS table_name,
            a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid
         WHERE c.relkind IN ('r', 'v', 'm', 'p')
           AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pgr', 'pgstack')
           AND a.attnum > 0
           AND NOT a.attisdropped
         ORDER BY n.nspname, c.relname, a.attnum"
    )
    .fetch_all(pool)
    .await?;

    let mut tables: HashMap<String, TableMeta> = HashMap::new();

    for row in &col_rows {
        let schema: String = row.get("schema_name");
        let table: String = row.get("table_name");
        let key = format!("{}.{}", schema, table);

        let entry = tables.entry(key).or_insert_with(|| TableMeta {
            schema: schema.clone(),
            name: table.clone(),
            columns: Vec::new(),
            primary_keys: Vec::new(),
            foreign_keys: Vec::new(),
        });

        entry.columns.push(ColumnMeta {
            name: row.get("column_name"),
            pg_type: row.get("data_type"),
        });
    }

    // Load primary keys
    let pk_rows = sqlx::query(
        "SELECT
            n.nspname AS schema_name,
            c.relname AS table_name,
            a.attname AS column_name
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
         WHERE i.indisprimary
           AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pgr', 'pgstack')
         ORDER BY n.nspname, c.relname, array_position(i.indkey, a.attnum)"
    )
    .fetch_all(pool)
    .await?;

    for row in &pk_rows {
        let schema: String = row.get("schema_name");
        let table: String = row.get("table_name");
        let key = format!("{}.{}", schema, table);
        if let Some(t) = tables.get_mut(&key) {
            t.primary_keys.push(row.get("column_name"));
        }
    }

    // Load foreign keys
    let fk_rows = sqlx::query(
        "SELECT
            cn.nspname AS schema_name,
            cc.relname AS table_name,
            array_agg(a1.attname ORDER BY pos) AS columns,
            fn_.nspname AS ref_schema,
            fc.relname AS ref_table,
            array_agg(a2.attname ORDER BY pos) AS ref_columns
         FROM pg_constraint con
         JOIN pg_class cc ON cc.oid = con.conrelid
         JOIN pg_namespace cn ON cn.oid = cc.relnamespace
         JOIN pg_class fc ON fc.oid = con.confrelid
         JOIN pg_namespace fn_ ON fn_.oid = fc.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(col, ref_col, pos)
         JOIN pg_attribute a1 ON a1.attrelid = con.conrelid AND a1.attnum = u.col
         JOIN pg_attribute a2 ON a2.attrelid = con.confrelid AND a2.attnum = u.ref_col
         WHERE con.contype = 'f'
           AND cn.nspname NOT IN ('pg_catalog', 'information_schema', 'pgr', 'pgstack')
         GROUP BY cn.nspname, cc.relname, fn_.nspname, fc.relname
         ORDER BY cn.nspname, cc.relname"
    )
    .fetch_all(pool)
    .await?;

    for row in &fk_rows {
        let schema: String = row.get("schema_name");
        let table: String = row.get("table_name");
        let key = format!("{}.{}", schema, table);
        let ref_schema: String = row.get("ref_schema");
        let ref_table: String = row.get("ref_table");

        if let Some(t) = tables.get_mut(&key) {
            t.foreign_keys.push(ForeignKey {
                columns: row.get("columns"),
                referenced_table: format!("{}.{}", ref_schema, ref_table),
                referenced_columns: row.get("ref_columns"),
            });
        }
    }

    Ok(tables)
}
