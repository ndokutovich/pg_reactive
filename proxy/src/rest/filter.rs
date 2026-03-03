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
                    let v = value.parse::<i64>().map_err(|_| {
                        AppError::BadRequest("invalid limit value".into())
                    })?;
                    if v < 0 {
                        return Err(AppError::BadRequest("limit must not be negative".into()));
                    }
                    result.limit = Some(v);
                }
                "offset" => {
                    let v = value.parse::<i64>().map_err(|_| {
                        AppError::BadRequest("invalid offset value".into())
                    })?;
                    if v < 0 {
                        return Err(AppError::BadRequest("offset must not be negative".into()));
                    }
                    result.offset = Some(v);
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
            "invalid filter for '{column}': expected operator.value, got '{raw}'"
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
                "unknown filter operator: '{op_str}'"
            )))
        }
    };

    // Validate column name (prevent SQL injection)
    if !is_valid_identifier(column) {
        return Err(AppError::BadRequest(format!(
            "invalid column name: '{column}'"
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
                "invalid order column: '{column}'"
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
                        "invalid order modifier: '{seg}'"
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

#[cfg(test)]
mod tests {
    use super::*;

    // ---- parse_filter operator tests ----

    #[test]
    fn test_eq_operator() {
        let q = RestQuery::parse(Some("id=eq.42")).unwrap();
        assert_eq!(q.filters.len(), 1);
        let f = &q.filters[0];
        assert_eq!(f.column, "id");
        assert_eq!(f.operator, FilterOp::Eq);
        assert_eq!(f.value, "42");
        assert!(!f.negate);
    }

    #[test]
    fn test_neq_operator() {
        let q = RestQuery::parse(Some("status=neq.inactive")).unwrap();
        let f = &q.filters[0];
        assert_eq!(f.operator, FilterOp::Neq);
        assert_eq!(f.value, "inactive");
    }

    #[test]
    fn test_lt_operator() {
        let q = RestQuery::parse(Some("age=lt.18")).unwrap();
        assert_eq!(q.filters[0].operator, FilterOp::Lt);
        assert_eq!(q.filters[0].value, "18");
    }

    #[test]
    fn test_lte_operator() {
        let q = RestQuery::parse(Some("score=lte.100")).unwrap();
        assert_eq!(q.filters[0].operator, FilterOp::Lte);
    }

    #[test]
    fn test_gt_operator() {
        let q = RestQuery::parse(Some("price=gt.0")).unwrap();
        assert_eq!(q.filters[0].operator, FilterOp::Gt);
    }

    #[test]
    fn test_gte_operator() {
        let q = RestQuery::parse(Some("rank=gte.1")).unwrap();
        assert_eq!(q.filters[0].operator, FilterOp::Gte);
    }

    #[test]
    fn test_like_operator() {
        let q = RestQuery::parse(Some("name=like.*foo*")).unwrap();
        let f = &q.filters[0];
        assert_eq!(f.operator, FilterOp::Like);
        assert_eq!(f.value, "*foo*");
    }

    #[test]
    fn test_ilike_operator() {
        let q = RestQuery::parse(Some("email=ilike.*@example.com")).unwrap();
        assert_eq!(q.filters[0].operator, FilterOp::Ilike);
    }

    #[test]
    fn test_is_null_operator() {
        let q = RestQuery::parse(Some("deleted_at=is.null")).unwrap();
        let f = &q.filters[0];
        assert_eq!(f.operator, FilterOp::Is);
        assert_eq!(f.value, "null");
    }

    #[test]
    fn test_is_true_operator() {
        let q = RestQuery::parse(Some("active=is.true")).unwrap();
        assert_eq!(q.filters[0].value, "true");
    }

    #[test]
    fn test_is_false_operator() {
        let q = RestQuery::parse(Some("enabled=is.false")).unwrap();
        assert_eq!(q.filters[0].value, "false");
    }

    #[test]
    fn test_in_operator() {
        let q = RestQuery::parse(Some("status=in.(active,pending,draft)")).unwrap();
        let f = &q.filters[0];
        assert_eq!(f.operator, FilterOp::In);
        assert_eq!(f.value, "(active,pending,draft)");
    }

    #[test]
    fn test_cs_operator() {
        let q = RestQuery::parse(Some("tags=cs.(news,tech)")).unwrap();
        assert_eq!(q.filters[0].operator, FilterOp::Cs);
    }

    #[test]
    fn test_cd_operator() {
        let q = RestQuery::parse(Some("tags=cd.(news,tech)")).unwrap();
        assert_eq!(q.filters[0].operator, FilterOp::Cd);
    }

    #[test]
    fn test_fts_operator() {
        let q = RestQuery::parse(Some("body=fts.hello")).unwrap();
        assert_eq!(q.filters[0].operator, FilterOp::Fts);
    }

    // ---- negate (not.) prefix ----

    #[test]
    fn test_not_eq_operator() {
        let q = RestQuery::parse(Some("id=not.eq.5")).unwrap();
        let f = &q.filters[0];
        assert_eq!(f.operator, FilterOp::Eq);
        assert!(f.negate);
        assert_eq!(f.value, "5");
    }

    #[test]
    fn test_not_in_operator() {
        let q = RestQuery::parse(Some("role=not.in.(admin,superadmin)")).unwrap();
        let f = &q.filters[0];
        assert_eq!(f.operator, FilterOp::In);
        assert!(f.negate);
        assert_eq!(f.value, "(admin,superadmin)");
    }

    // ---- multiple filters ----

    #[test]
    fn test_multiple_filters() {
        let q = RestQuery::parse(Some("age=gte.18&age=lte.65&active=is.true")).unwrap();
        assert_eq!(q.filters.len(), 3);
        assert_eq!(q.filters[0].operator, FilterOp::Gte);
        assert_eq!(q.filters[1].operator, FilterOp::Lte);
        assert_eq!(q.filters[2].operator, FilterOp::Is);
    }

    // ---- unknown operator ----

    #[test]
    fn test_unknown_operator_returns_error() {
        let result = RestQuery::parse(Some("id=fuzzy.5"));
        assert!(result.is_err());
        let msg = format!("{:?}", result.unwrap_err());
        assert!(msg.contains("unknown filter operator"));
    }

    // ---- missing operator.value format ----

    #[test]
    fn test_missing_dot_separator_returns_error() {
        let result = RestQuery::parse(Some("id=42"));
        assert!(result.is_err());
        let msg = format!("{:?}", result.unwrap_err());
        assert!(msg.contains("invalid filter") || msg.contains("expected operator.value"));
    }

    // ---- column name validation (injection prevention) ----

    #[test]
    fn test_sql_injection_in_column_name_rejected() {
        let result = RestQuery::parse(Some("id;DROP TABLE users=eq.1"));
        assert!(result.is_err());
    }

    #[test]
    fn test_column_with_quote_rejected() {
        let result = RestQuery::parse(Some("\"id\"=eq.1"));
        // URL-decoded the column becomes "id" with quotes — invalid identifier
        assert!(result.is_err());
    }

    #[test]
    fn test_column_starting_with_digit_rejected() {
        let result = RestQuery::parse(Some("1col=eq.value"));
        assert!(result.is_err());
    }

    #[test]
    fn test_column_too_long_rejected() {
        // 64-char column name exceeds 63-char PG limit
        let long_col = "a".repeat(64);
        let qs = format!("{}=eq.1", long_col);
        let result = RestQuery::parse(Some(&qs));
        assert!(result.is_err());
    }

    #[test]
    fn test_valid_column_with_underscore() {
        let q = RestQuery::parse(Some("created_at=eq.2024")).unwrap();
        assert_eq!(q.filters[0].column, "created_at");
    }

    // ---- limit / offset parsing ----

    #[test]
    fn test_limit_parsed() {
        let q = RestQuery::parse(Some("limit=10")).unwrap();
        assert_eq!(q.limit, Some(10));
    }

    #[test]
    fn test_offset_parsed() {
        let q = RestQuery::parse(Some("offset=20")).unwrap();
        assert_eq!(q.offset, Some(20));
    }

    #[test]
    fn test_negative_limit_rejected() {
        let result = RestQuery::parse(Some("limit=-1"));
        assert!(result.is_err());
    }

    #[test]
    fn test_negative_offset_rejected() {
        let result = RestQuery::parse(Some("offset=-5"));
        assert!(result.is_err());
    }

    #[test]
    fn test_non_numeric_limit_rejected() {
        let result = RestQuery::parse(Some("limit=abc"));
        assert!(result.is_err());
    }

    // ---- order parsing ----

    #[test]
    fn test_order_asc() {
        let q = RestQuery::parse(Some("order=created_at.asc")).unwrap();
        assert_eq!(q.order.len(), 1);
        assert_eq!(q.order[0].column, "created_at");
        assert!(q.order[0].ascending);
    }

    #[test]
    fn test_order_desc() {
        let q = RestQuery::parse(Some("order=id.desc")).unwrap();
        assert!(!q.order[0].ascending);
    }

    #[test]
    fn test_order_nullsfirst() {
        let q = RestQuery::parse(Some("order=name.asc.nullsfirst")).unwrap();
        assert_eq!(q.order[0].nulls_first, Some(true));
    }

    #[test]
    fn test_order_nullslast() {
        let q = RestQuery::parse(Some("order=name.desc.nullslast")).unwrap();
        assert_eq!(q.order[0].nulls_first, Some(false));
    }

    #[test]
    fn test_order_multiple_columns() {
        let q = RestQuery::parse(Some("order=name.asc,id.desc")).unwrap();
        assert_eq!(q.order.len(), 2);
        assert_eq!(q.order[0].column, "name");
        assert_eq!(q.order[1].column, "id");
        assert!(!q.order[1].ascending);
    }

    #[test]
    fn test_order_invalid_modifier_rejected() {
        let result = RestQuery::parse(Some("order=name.random"));
        assert!(result.is_err());
    }

    // ---- select passthrough ----

    #[test]
    fn test_select_param_stored() {
        let q = RestQuery::parse(Some("select=id,name,email")).unwrap();
        assert_eq!(q.select.as_deref(), Some("id,name,email"));
    }

    // ---- empty / None query string ----

    #[test]
    fn test_empty_query_string() {
        let q = RestQuery::parse(Some("")).unwrap();
        assert!(q.filters.is_empty());
        assert!(q.order.is_empty());
        assert!(q.limit.is_none());
    }

    #[test]
    fn test_none_query_string() {
        let q = RestQuery::parse(None).unwrap();
        assert!(q.filters.is_empty());
    }

    // ---- FilterOp::sql_op ----

    #[test]
    fn test_sql_op_strings() {
        assert_eq!(FilterOp::Eq.sql_op(), "=");
        assert_eq!(FilterOp::Neq.sql_op(), "!=");
        assert_eq!(FilterOp::Gt.sql_op(), ">");
        assert_eq!(FilterOp::Gte.sql_op(), ">=");
        assert_eq!(FilterOp::Lt.sql_op(), "<");
        assert_eq!(FilterOp::Lte.sql_op(), "<=");
        assert_eq!(FilterOp::Like.sql_op(), "LIKE");
        assert_eq!(FilterOp::Ilike.sql_op(), "ILIKE");
        assert_eq!(FilterOp::Is.sql_op(), "IS");
        assert_eq!(FilterOp::In.sql_op(), "= ANY");
        assert_eq!(FilterOp::Cs.sql_op(), "@>");
        assert_eq!(FilterOp::Cd.sql_op(), "<@");
        assert_eq!(FilterOp::Fts.sql_op(), "@@");
    }
}
