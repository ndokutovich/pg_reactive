use crate::error::AppError;
use crate::rest::catalog::{Catalog, TableMeta};
use crate::rest::query_builder;

/// Maximum nesting depth for resource embedding (prevents query explosion).
const MAX_EMBED_DEPTH: usize = 3;

/// A parsed resource embedding request from `?select=*,relation(col1,col2,child(c1,c2))`.
/// Supports recursive nesting: each embed can itself contain child embeds.
#[derive(Debug, Clone)]
pub struct EmbedRequest {
    /// Name of the related table (or relation hint)
    pub relation: String,
    /// Columns to select from the related table (empty = all)
    pub columns: Vec<String>,
    /// Nested child embeds within this relation
    pub children: Vec<EmbedRequest>,
}

/// Resolved embedding with FK join info.
#[derive(Debug, Clone)]
pub struct ResolvedEmbed {
    pub relation_name: String,
    pub target_table: TableMeta,
    pub join: EmbedJoin,
    pub columns: Vec<String>,
    /// Resolved nested child embeds
    pub children: Vec<ResolvedEmbed>,
}

/// How the embed joins to the parent.
#[derive(Debug, Clone)]
pub enum EmbedJoin {
    /// Parent has FK → child (many-to-one). Returns single object.
    ManyToOne {
        /// Column(s) in the parent table
        parent_columns: Vec<String>,
        /// Column(s) in the target table
        target_columns: Vec<String>,
    },
    /// Child has FK → parent (one-to-many). Returns array.
    OneToMany {
        /// Column(s) in the target (child) table that reference parent
        child_columns: Vec<String>,
        /// Column(s) in the parent table being referenced
        parent_columns: Vec<String>,
    },
}

/// Parse embedded relations from the `select` parameter.
/// Example: `*,comments(id,body,author(name)),tags(label)` → two EmbedRequests,
/// where the first has a nested child embed for `author`.
pub fn parse_embeds(select: Option<&str>) -> Vec<EmbedRequest> {
    let s = match select {
        Some(s) if !s.is_empty() => s,
        _ => return Vec::new(),
    };

    // Split top-level segments by comma (respecting parentheses depth),
    // then try to parse each segment as an embed.
    let segments = split_top_level(s);
    let mut embeds = Vec::new();
    for segment in &segments {
        if let Some(embed) = try_parse_embed(segment) {
            embeds.push(embed);
        }
    }
    embeds
}

/// Split a string by commas at parentheses depth 0.
fn split_top_level(s: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut depth = 0;

    for ch in s.chars() {
        match ch {
            '(' => {
                depth += 1;
                current.push(ch);
            }
            ')' => {
                depth -= 1;
                current.push(ch);
            }
            ',' if depth == 0 => {
                let trimmed = current.trim().to_string();
                if !trimmed.is_empty() {
                    result.push(trimmed);
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }

    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        result.push(trimmed);
    }

    result
}

/// Try to parse a segment like `comments(id,body,author(name,email))` into an
/// `EmbedRequest`. Returns `None` for plain column names (no parens).
fn try_parse_embed(segment: &str) -> Option<EmbedRequest> {
    let segment = segment.trim();
    let open = segment.find('(')?;
    let close = segment.rfind(')')?;
    if close <= open {
        return None;
    }

    let relation = segment[..open].trim().to_string();
    let inner = segment[open + 1..close].trim();

    if inner.is_empty() || inner == "*" {
        return Some(EmbedRequest {
            relation,
            columns: Vec::new(),
            children: Vec::new(),
        });
    }

    // Split the inner content by top-level commas. Each part is either a plain
    // column name or a nested embed like `author(name,email)`.
    let parts = split_top_level(inner);
    let mut columns = Vec::new();
    let mut children = Vec::new();

    for part in &parts {
        if let Some(child_embed) = try_parse_embed(part) {
            // It's a nested embed
            children.push(child_embed);
        } else {
            // It's a plain column name
            let col = part.trim().to_string();
            if !col.is_empty() && col != "*" {
                columns.push(col);
            }
        }
    }

    Some(EmbedRequest {
        relation,
        columns,
        children,
    })
}

/// Resolve an embed request against the catalog, finding the FK relationship.
/// Recursively resolves nested children up to `MAX_EMBED_DEPTH`.
pub async fn resolve_embed(
    catalog: &Catalog,
    parent: &TableMeta,
    embed: &EmbedRequest,
) -> Result<ResolvedEmbed, AppError> {
    resolve_embed_recursive(catalog, parent, embed, 1).await
}

/// Internal recursive resolver with depth tracking.
/// Uses `Box::pin` to handle recursive async (Rust requires indirection for
/// recursive futures to have a finite size).
fn resolve_embed_recursive<'a>(
    catalog: &'a Catalog,
    parent: &'a TableMeta,
    embed: &'a EmbedRequest,
    depth: usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ResolvedEmbed, AppError>> + Send + 'a>>
{
    Box::pin(async move {
        if depth > MAX_EMBED_DEPTH {
            return Err(AppError::BadRequest(format!(
                "embedding depth exceeds maximum of {} levels (at '{}')",
                MAX_EMBED_DEPTH, embed.relation
            )));
        }

        let target = catalog
            .get_table(&embed.relation)
            .await
            .ok_or_else(|| {
                AppError::BadRequest(format!(
                    "embedded relation '{}' not found",
                    embed.relation
                ))
            })?;

        let target_qualified = format!("{}.{}", target.schema, target.name);
        let parent_qualified = format!("{}.{}", parent.schema, parent.name);

        // Determine the join direction.
        let join = find_join(parent, &target, &parent_qualified, &target_qualified)
            .ok_or_else(|| {
                AppError::BadRequest(format!(
                    "no foreign key relationship found between '{}' and '{}'",
                    parent.name, embed.relation
                ))
            })?;

        // Recursively resolve children
        let mut resolved_children = Vec::new();
        for child in &embed.children {
            resolved_children
                .push(resolve_embed_recursive(catalog, &target, child, depth + 1).await?);
        }

        Ok(ResolvedEmbed {
            relation_name: embed.relation.clone(),
            target_table: target,
            join,
            columns: embed.columns.clone(),
            children: resolved_children,
        })
    })
}

/// Find the FK join between parent and target. Returns `None` if no FK exists.
fn find_join(
    parent: &TableMeta,
    target: &TableMeta,
    parent_qualified: &str,
    target_qualified: &str,
) -> Option<EmbedJoin> {
    // Strategy 1: Parent has FK → target (many-to-one, returns object)
    for fk in &parent.foreign_keys {
        if fk.referenced_table == target_qualified {
            return Some(EmbedJoin::ManyToOne {
                parent_columns: fk.columns.clone(),
                target_columns: fk.referenced_columns.clone(),
            });
        }
    }

    // Strategy 2: Target has FK → parent (one-to-many, returns array)
    for fk in &target.foreign_keys {
        if fk.referenced_table == parent_qualified {
            return Some(EmbedJoin::OneToMany {
                child_columns: fk.columns.clone(),
                parent_columns: fk.referenced_columns.clone(),
            });
        }
    }

    None
}

/// Build a LATERAL subquery SQL fragment for a resolved embed, including any
/// nested children. Returns `(select_expr, join_clause)`.
///
/// - `parent_alias`: the alias of the parent table/subquery in the outer FROM
/// - `global_counter`: mutable counter to ensure globally unique aliases across
///   all levels of nesting
pub fn build_lateral_sql(
    emb: &ResolvedEmbed,
    parent_alias: &str,
    global_counter: &mut usize,
) -> (String, String) {
    let my_index = *global_counter;
    *global_counter += 1;
    let alias = format!("_e{}", my_index);

    let target_from = format!(
        "{}.{}",
        query_builder::quote_ident(&emb.target_table.schema),
        query_builder::quote_ident(&emb.target_table.name)
    );

    // Build inner SELECT columns and child LATERAL JOINs in a single pass
    let (col_select, child_lateral_joins) =
        build_inner_select_and_joins(emb, global_counter, my_index);

    match &emb.join {
        EmbedJoin::OneToMany {
            child_columns,
            parent_columns,
        } => {
            let join_cond: Vec<String> = child_columns
                .iter()
                .zip(parent_columns.iter())
                .map(|(child_col, parent_col)| {
                    format!(
                        "sub.{} = {}.{}",
                        query_builder::quote_ident(child_col),
                        parent_alias,
                        query_builder::quote_ident(parent_col)
                    )
                })
                .collect();

            let lateral_join = format!(
                "LEFT JOIN LATERAL (\
                    SELECT COALESCE(json_agg(row_to_json(wrap)), '[]'::json) AS data \
                    FROM (\
                        SELECT {col_select} FROM {target_from} sub \
                        {child_lateral_joins} \
                        WHERE {join_cond}\
                    ) wrap\
                ) {alias} ON true",
                col_select = col_select,
                target_from = target_from,
                child_lateral_joins = child_lateral_joins,
                join_cond = join_cond.join(" AND "),
                alias = query_builder::quote_ident(&alias),
            );

            let select_expr = format!(
                "{}.data AS {}",
                query_builder::quote_ident(&alias),
                query_builder::quote_ident(&emb.relation_name)
            );

            (select_expr, lateral_join)
        }
        EmbedJoin::ManyToOne {
            parent_columns,
            target_columns,
        } => {
            let join_cond: Vec<String> = target_columns
                .iter()
                .zip(parent_columns.iter())
                .map(|(target_col, parent_col)| {
                    format!(
                        "sub.{} = {}.{}",
                        query_builder::quote_ident(target_col),
                        parent_alias,
                        query_builder::quote_ident(parent_col)
                    )
                })
                .collect();

            let lateral_join = format!(
                "LEFT JOIN LATERAL (\
                    SELECT row_to_json(wrap) AS data \
                    FROM (\
                        SELECT {col_select} FROM {target_from} sub \
                        {child_lateral_joins} \
                        WHERE {join_cond} LIMIT 1\
                    ) wrap\
                ) {alias} ON true",
                col_select = col_select,
                target_from = target_from,
                child_lateral_joins = child_lateral_joins,
                join_cond = join_cond.join(" AND "),
                alias = query_builder::quote_ident(&alias),
            );

            let select_expr = format!(
                "{}.data AS {}",
                query_builder::quote_ident(&alias),
                query_builder::quote_ident(&emb.relation_name)
            );

            (select_expr, lateral_join)
        }
    }
}

/// Build the inner SELECT columns and child LATERAL JOIN clauses for a resolved
/// embed in a single pass (so the global counter stays consistent).
fn build_inner_select_and_joins(
    emb: &ResolvedEmbed,
    global_counter: &mut usize,
    _my_index: usize,
) -> (String, String) {
    if emb.children.is_empty() {
        // No children: simple column select
        let col_select = if emb.columns.is_empty() {
            "sub.*".to_string()
        } else {
            emb.columns
                .iter()
                .map(|c| format!("sub.{}", query_builder::quote_ident(c)))
                .collect::<Vec<_>>()
                .join(", ")
        };
        return (col_select, String::new());
    }

    // Has children: build both select parts and join clauses together
    let mut select_parts: Vec<String> = Vec::new();
    let mut join_clauses: Vec<String> = Vec::new();

    // Base columns from this embed
    if emb.columns.is_empty() {
        select_parts.push("sub.*".to_string());
    } else {
        for c in &emb.columns {
            select_parts.push(format!("sub.{}", query_builder::quote_ident(c)));
        }
    }

    // Process each child: generates both its select expr and its lateral join
    for child in &emb.children {
        let (child_select, child_join) =
            build_lateral_sql(child, "sub", global_counter);
        select_parts.push(child_select);
        join_clauses.push(child_join);
    }

    (select_parts.join(", "), join_clauses.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_flat_embeds() {
        let embeds = parse_embeds(Some("id,title,comments(id,body),author(name)"));
        assert_eq!(embeds.len(), 2);
        assert_eq!(embeds[0].relation, "comments");
        assert_eq!(embeds[0].columns, vec!["id", "body"]);
        assert!(embeds[0].children.is_empty());
        assert_eq!(embeds[1].relation, "author");
        assert_eq!(embeds[1].columns, vec!["name"]);
        assert!(embeds[1].children.is_empty());
    }

    #[test]
    fn test_parse_nested_embeds() {
        let embeds =
            parse_embeds(Some("*,comments(id,body,author(name,email))"));
        assert_eq!(embeds.len(), 1);
        assert_eq!(embeds[0].relation, "comments");
        assert_eq!(embeds[0].columns, vec!["id", "body"]);
        assert_eq!(embeds[0].children.len(), 1);

        let nested = &embeds[0].children[0];
        assert_eq!(nested.relation, "author");
        assert_eq!(nested.columns, vec!["name", "email"]);
        assert!(nested.children.is_empty());
    }

    #[test]
    fn test_parse_deeply_nested() {
        let embeds = parse_embeds(Some(
            "comments(body,author(name,country(code)))",
        ));
        assert_eq!(embeds.len(), 1);
        assert_eq!(embeds[0].relation, "comments");
        assert_eq!(embeds[0].columns, vec!["body"]);
        assert_eq!(embeds[0].children.len(), 1);

        let author = &embeds[0].children[0];
        assert_eq!(author.relation, "author");
        assert_eq!(author.columns, vec!["name"]);
        assert_eq!(author.children.len(), 1);

        let country = &author.children[0];
        assert_eq!(country.relation, "country");
        assert_eq!(country.columns, vec!["code"]);
        assert!(country.children.is_empty());
    }

    #[test]
    fn test_parse_multiple_nested_siblings() {
        let embeds = parse_embeds(Some(
            "*,comments(id,author(name),tags(label))",
        ));
        assert_eq!(embeds.len(), 1);
        assert_eq!(embeds[0].relation, "comments");
        assert_eq!(embeds[0].columns, vec!["id"]);
        assert_eq!(embeds[0].children.len(), 2);
        assert_eq!(embeds[0].children[0].relation, "author");
        assert_eq!(embeds[0].children[0].columns, vec!["name"]);
        assert_eq!(embeds[0].children[1].relation, "tags");
        assert_eq!(embeds[0].children[1].columns, vec!["label"]);
    }

    #[test]
    fn test_parse_no_columns_with_children() {
        let embeds = parse_embeds(Some("comments(author(name))"));
        assert_eq!(embeds.len(), 1);
        assert_eq!(embeds[0].relation, "comments");
        assert!(embeds[0].columns.is_empty());
        assert_eq!(embeds[0].children.len(), 1);
        assert_eq!(embeds[0].children[0].relation, "author");
    }

    #[test]
    fn test_parse_empty_and_star() {
        let embeds = parse_embeds(Some("*"));
        assert!(embeds.is_empty());

        let embeds = parse_embeds(None);
        assert!(embeds.is_empty());

        let embeds = parse_embeds(Some(""));
        assert!(embeds.is_empty());
    }

    #[test]
    fn test_parse_wildcard_embed() {
        let embeds = parse_embeds(Some("comments(*)"));
        assert_eq!(embeds.len(), 1);
        assert_eq!(embeds[0].relation, "comments");
        assert!(embeds[0].columns.is_empty());
        assert!(embeds[0].children.is_empty());
    }
}
