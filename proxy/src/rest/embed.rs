use crate::error::AppError;
use crate::rest::catalog::{Catalog, TableMeta};

/// A parsed resource embedding request from `?select=*,relation(col1,col2)`.
#[derive(Debug, Clone)]
pub struct EmbedRequest {
    /// Name of the related table (or relation hint)
    pub relation: String,
    /// Columns to select from the related table (empty = all)
    pub columns: Vec<String>,
}

/// Resolved embedding with FK join info.
#[derive(Debug, Clone)]
pub struct ResolvedEmbed {
    pub relation_name: String,
    pub target_table: TableMeta,
    pub join: EmbedJoin,
    pub columns: Vec<String>,
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
/// Example: `*,comments(id,body),author(name)` → two EmbedRequests.
pub fn parse_embeds(select: Option<&str>) -> Vec<EmbedRequest> {
    let s = match select {
        Some(s) if !s.is_empty() => s,
        _ => return Vec::new(),
    };

    let mut embeds = Vec::new();
    let mut chars = s.chars().peekable();
    let mut current = String::new();

    // Parse respecting parentheses nesting
    let mut depth = 0;
    while let Some(ch) = chars.next() {
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
                if let Some(embed) = try_parse_embed(&current) {
                    embeds.push(embed);
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }

    // Last segment
    if let Some(embed) = try_parse_embed(&current) {
        embeds.push(embed);
    }

    embeds
}

fn try_parse_embed(segment: &str) -> Option<EmbedRequest> {
    let segment = segment.trim();
    let open = segment.find('(')?;
    let close = segment.rfind(')')?;
    if close <= open {
        return None;
    }

    let relation = segment[..open].trim().to_string();
    let inner = segment[open + 1..close].trim();

    let columns = if inner.is_empty() || inner == "*" {
        Vec::new()
    } else {
        inner.split(',').map(|c| c.trim().to_string()).collect()
    };

    Some(EmbedRequest { relation, columns })
}

/// Resolve an embed request against the catalog, finding the FK relationship.
pub async fn resolve_embed(
    catalog: &Catalog,
    parent: &TableMeta,
    embed: &EmbedRequest,
) -> Result<ResolvedEmbed, AppError> {
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

    // Strategy 1: Parent has FK → target (many-to-one, returns object)
    for fk in &parent.foreign_keys {
        if fk.referenced_table == target_qualified {
            return Ok(ResolvedEmbed {
                relation_name: embed.relation.clone(),
                target_table: target,
                join: EmbedJoin::ManyToOne {
                    parent_columns: fk.columns.clone(),
                    target_columns: fk.referenced_columns.clone(),
                },
                columns: embed.columns.clone(),
            });
        }
    }

    // Strategy 2: Target has FK → parent (one-to-many, returns array)
    // Clone FK data before consuming target to avoid borrow-after-move.
    let target_fk_match = target
        .foreign_keys
        .iter()
        .find(|fk| fk.referenced_table == parent_qualified)
        .cloned();

    if let Some(fk) = target_fk_match {
        return Ok(ResolvedEmbed {
            relation_name: embed.relation.clone(),
            target_table: target,
            join: EmbedJoin::OneToMany {
                child_columns: fk.columns,
                parent_columns: fk.referenced_columns,
            },
            columns: embed.columns.clone(),
        });
    }

    Err(AppError::BadRequest(format!(
        "no foreign key relationship found between '{}' and '{}'",
        parent.name, embed.relation
    )))
}
