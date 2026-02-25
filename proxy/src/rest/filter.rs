use crate::error::AppError;

/// A parsed filter condition from a query parameter.
#[derive(Debug, Clone)]
pub struct Filter {
    pub column: String,
    pub operator: FilterOp,
    pub value: String,
    /// Negate the condition (e.g., not.eq)
    pub negate: bool,
}

/// PostgREST-compatible filter operators.
#[derive(Debug, Clone, PartialEq)]
pub enum FilterOp {
    Eq,    // =
    Neq,   // !=
    Gt,    // >
    Gte,   // >=
    Lt,    // <
    Lte,   // <=
    Like,  // LIKE
    Ilike, // ILIKE
    Is,    // IS (null, true, false)
    In,    // IN (...)
    Cs,    // @> (contains)
    Cd,    // <@ (contained by)
    Fts,   // @@ (full-text search)
}

/// Ordering direction.
#[derive(Debug, Clone)]
pub struct OrderClause {
    pub column: String,
    pub ascending: bool,
    pub nulls_first: Option<bool>,
}

/// Parsed query parameters for a REST request.
#[derive(Debug, Default)]
pub struct RestQuery {
    pub select: Option<String>,
    pub filters: Vec<Filter>,
    pub order: Vec<OrderClause>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

impl RestQuery {
    /// Parse from URL query string (e.g., "id=eq.5&name=like.*foo*&order=id.asc&limit=10").
    pub fn parse(query: Option<&str>) -> Result<Self, AppError> {
        let mut result = RestQuery::default();

        let q = match query {
            Some(q) if !q.is_empty() => q,
            _ => return Ok(result),
        };

        for pair in q.split('&') {
            let (key, value) = match pair.split_once('=') {
                Some((k, v)) => (k, v),
                None => continue,
            };

            let key = urlencoding::decode(key)
                .map_err(|_| AppError::BadRequest("invalid URL encoding".into()))?;
            let value = urlencoding::decode(value)
                .map_err(|_| AppError::BadRequest("invalid URL encoding".into()))?;

            match key.as_ref() {
                "select" => result.select = Some(value.into_owned()),
                "order" => result.order = parse_order(&value)?,
                "limit" => {
                    result.limit = Some(value.parse::<i64>().map_err(|_| {
                        AppError::BadRequest("invalid limit value".into())
                    })?);
                }
                "offset" => {
                    result.offset = Some(value.parse::<i64>().map_err(|_| {
                        AppError::BadRequest("invalid offset value".into())
                    })?);
                }
                _ => {
                    // Column filter: column=operator.value
                    result.filters.push(parse_filter(&key, &value)?);
                }
            }
        }

        Ok(result)
    }
}

fn parse_filter(column: &str, raw: &str) -> Result<Filter, AppError> {
    // Check for not. prefix
    let (negate, rest) = if let Some(r) = raw.strip_prefix("not.") {
        (true, r)
    } else {
        (false, raw)
    };

    // Split on first dot: operator.value
    let (op_str, value) = rest.split_once('.').ok_or_else(|| {
        AppError::BadRequest(format!(
            "invalid filter for '{}': expected operator.value, got '{}'",
            column, raw
        ))
    })?;

    let operator = match op_str {
        "eq" => FilterOp::Eq,
        "neq" => FilterOp::Neq,
        "gt" => FilterOp::Gt,
        "gte" => FilterOp::Gte,
        "lt" => FilterOp::Lt,
        "lte" => FilterOp::Lte,
        "like" => FilterOp::Like,
        "ilike" => FilterOp::Ilike,
        "is" => FilterOp::Is,
        "in" => FilterOp::In,
        "cs" => FilterOp::Cs,
        "cd" => FilterOp::Cd,
        "fts" => FilterOp::Fts,
        _ => {
            return Err(AppError::BadRequest(format!(
                "unknown filter operator: '{}'",
                op_str
            )))
        }
    };

    // Validate column name (prevent SQL injection)
    if !is_valid_identifier(column) {
        return Err(AppError::BadRequest(format!(
            "invalid column name: '{}'",
            column
        )));
    }

    Ok(Filter {
        column: column.to_string(),
        operator,
        value: value.to_string(),
        negate,
    })
}

fn parse_order(raw: &str) -> Result<Vec<OrderClause>, AppError> {
    let mut result = Vec::new();

    for part in raw.split(',') {
        let segments: Vec<&str> = part.split('.').collect();
        if segments.is_empty() {
            continue;
        }

        let column = segments[0].to_string();
        if !is_valid_identifier(&column) {
            return Err(AppError::BadRequest(format!(
                "invalid order column: '{}'",
                column
            )));
        }

        let mut ascending = true;
        let mut nulls_first = None;

        for &seg in &segments[1..] {
            match seg {
                "asc" => ascending = true,
                "desc" => ascending = false,
                "nullsfirst" => nulls_first = Some(true),
                "nullslast" => nulls_first = Some(false),
                _ => {
                    return Err(AppError::BadRequest(format!(
                        "invalid order modifier: '{}'",
                        seg
                    )))
                }
            }
        }

        result.push(OrderClause {
            column,
            ascending,
            nulls_first,
        });
    }

    Ok(result)
}

/// Validate that a string is a safe SQL identifier (no injection).
fn is_valid_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !s.chars().next().unwrap().is_ascii_digit()
}

impl FilterOp {
    /// SQL operator string.
    pub fn sql_op(&self) -> &'static str {
        match self {
            FilterOp::Eq => "=",
            FilterOp::Neq => "!=",
            FilterOp::Gt => ">",
            FilterOp::Gte => ">=",
            FilterOp::Lt => "<",
            FilterOp::Lte => "<=",
            FilterOp::Like => "LIKE",
            FilterOp::Ilike => "ILIKE",
            FilterOp::Is => "IS",
            FilterOp::In => "= ANY",
            FilterOp::Cs => "@>",
            FilterOp::Cd => "<@",
            FilterOp::Fts => "@@",
        }
    }
}
