//! Supabase-storage-compatible buckets + objects — `/storage/v1/...`.
//!
//! Port of the Go reference `proxy-go/routes/storage.go`. Ownership is enforced
//! in the handler + owner-locked upsert SQL (NOT PG RLS), so every query runs on
//! the admin (service_role) pool — service_role has BYPASSRLS + explicit DML
//! grants on `pgstack.storage_buckets` / `pgstack.storage_objects` (init.sql).
//!
//! Security-relevant rules mirrored from Go (SECURITY.md storage surface):
//!   - bucket create/delete require service_role (audit F-bucket-admin);
//!   - anon may NOT upload or delete to any bucket — "public" means anon READ,
//!     never anon WRITE (audit F4, round 14);
//!   - a private bucket's objects require auth AND owner/service_role match;
//!     a public bucket allows anonymous read (init.sql storage RLS mirror);
//!   - an object's owner is the only principal who may overwrite/delete it,
//!     unless the caller is service_role — the owner-locked upsert's
//!     `WHERE owner IS NOT DISTINCT FROM EXCLUDED.owner` yields 0 rows → 403
//!     (audit F1, rounds 14-21);
//!   - object paths are traversal-safe (`safe_storage_path`) and bucket ids are
//!     on-disk-safe and cannot collide with the reserved staging dir (F3 r21);
//!   - the disk backend stages uploads in a reserved dir and atomically renames,
//!     and a startup orphan sweep removes partial-upload leftovers (F1 r19/r20).

use std::path::{Component, Path as FsPath, PathBuf};

use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use sqlx::Row;
use tracing::error;

use crate::error::AppError;
use crate::middleware::rls::RequestClaims;
use crate::state::AppState;

/// 50 MB — the default per-bucket and global object size ceiling (mirror Go).
const DEFAULT_FILE_SIZE_LIMIT: i64 = 52428800;

/// Reserved directory under STORAGE_DIR holding every upload temp file and
/// overwrite/delete backup. Living OUTSIDE the bucket namespace means the orphan
/// sweep can never collide with a legitimate object name (audit F1 round 20).
const STAGING_SUBDIR: &str = ".pgstack-staging";

// ── owner-locked upserts (audit F1, rounds 14-21) ───────────────────────────
//
// The UPDATE branch's WHERE refuses ownership transfer: a concurrent first-write
// race or a deliberate overwrite by a different user produces 0 rows in
// RETURNING, which the caller maps to 403. `service_role` gets a separate path
// that may overwrite anyone (admin), preserving the existing owner. The owner
// param is bound as text and cast `::uuid` so a NULL (service_role with no sub)
// and a real uuid both work without the sqlx `uuid` feature.

const UPSERT_DB_OWNER_LOCKED: &str = "\
    INSERT INTO pgstack.storage_objects (bucket_id, name, size, mime_type, data, owner) \
    VALUES ($1, $2, $3, $4, $5, $6::uuid) \
    ON CONFLICT (bucket_id, name) DO UPDATE \
       SET size = EXCLUDED.size, mime_type = EXCLUDED.mime_type, \
           data = EXCLUDED.data, updated_at = now() \
       WHERE pgstack.storage_objects.owner IS NOT DISTINCT FROM EXCLUDED.owner \
    RETURNING id::text";

const UPSERT_DB_SERVICE_ROLE: &str = "\
    INSERT INTO pgstack.storage_objects (bucket_id, name, size, mime_type, data, owner) \
    VALUES ($1, $2, $3, $4, $5, $6::uuid) \
    ON CONFLICT (bucket_id, name) DO UPDATE \
       SET size = EXCLUDED.size, mime_type = EXCLUDED.mime_type, \
           data = EXCLUDED.data, updated_at = now() \
    RETURNING id::text";

const UPSERT_DISK_OWNER_LOCKED: &str = "\
    INSERT INTO pgstack.storage_objects (bucket_id, name, size, mime_type, data, owner) \
    VALUES ($1, $2, $3, $4, NULL, $5::uuid) \
    ON CONFLICT (bucket_id, name) DO UPDATE \
       SET size = EXCLUDED.size, mime_type = EXCLUDED.mime_type, \
           data = NULL, updated_at = now() \
       WHERE pgstack.storage_objects.owner IS NOT DISTINCT FROM EXCLUDED.owner \
    RETURNING id::text";

const UPSERT_DISK_SERVICE_ROLE: &str = "\
    INSERT INTO pgstack.storage_objects (bucket_id, name, size, mime_type, data, owner) \
    VALUES ($1, $2, $3, $4, NULL, $5::uuid) \
    ON CONFLICT (bucket_id, name) DO UPDATE \
       SET size = EXCLUDED.size, mime_type = EXCLUDED.mime_type, \
           data = NULL, updated_at = now() \
    RETURNING id::text";

/// RFC3339-ish UTC timestamp expression for SELECTs (mirror Go's time.RFC3339).
const TS_RFC3339: &str = "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')";

// ── bucket-id + path validation ─────────────────────────────────────────────

/// On-disk-safe bucket id: `^[a-z0-9][a-z0-9_-]{0,62}$` and not the reserved
/// staging dir. Conservative on purpose — rejects dots, slashes, uppercase
/// (audit F3 round 21). Implemented without the `regex` crate.
pub fn valid_bucket_id(id: &str) -> bool {
    if id == STAGING_SUBDIR {
        return false;
    }
    if id.is_empty() || id.len() > 63 {
        return false;
    }
    let bytes = id.as_bytes();
    let first = bytes[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    bytes
        .iter()
        .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// Join root + bucket + obj and guarantee the resolved path stays inside the
/// bucket's own subtree. Mirror of Go `safeStoragePath`: rejects empty inputs,
/// absolute/drive/UNC object names, NUL, traversal, and bucket ids containing
/// `/`, `\`, or `..`. Returns the cleaned absolute path or an error message.
pub fn safe_storage_path(root: &str, bucket_id: &str, obj_name: &str) -> Result<PathBuf, String> {
    if root.is_empty() {
        return Err("storage root not configured".into());
    }
    if bucket_id.is_empty() || obj_name.is_empty() {
        return Err("bucket and object are required".into());
    }
    // Reject obvious shapes before touching the filesystem.
    if obj_name.starts_with('/')
        || obj_name.starts_with('\\')
        || obj_name.contains("\\\\")
        || FsPath::new(obj_name).is_absolute()
    {
        return Err("object path must be relative".into());
    }
    // Drive letter (e.g. C:) and NUL — defence-in-depth even on POSIX.
    if obj_name.as_bytes().get(1) == Some(&b':') {
        return Err("object path must be relative".into());
    }
    if obj_name.contains('\0') {
        return Err("object path contains NUL".into());
    }
    if bucket_id.contains('/') || bucket_id.contains('\\') || bucket_id.contains("..") {
        return Err("invalid bucket id".into());
    }

    let abs_root = std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
    let bucket_root = abs_root.join(bucket_id);

    // Manually resolve `.`/`..` components without requiring the path to exist
    // (filepath.Clean semantics). Any `..` that pops above the bucket root, or
    // any absolute/prefix component in the object name, escapes the bucket.
    let mut cleaned = bucket_root.clone();
    for comp in FsPath::new(obj_name).components() {
        match comp {
            Component::CurDir => {}
            Component::Normal(seg) => cleaned.push(seg),
            Component::ParentDir => {
                if !cleaned.pop() || !cleaned.starts_with(&bucket_root) {
                    return Err("object path escapes bucket".into());
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("object path must be relative".into());
            }
        }
    }
    if !cleaned.starts_with(&bucket_root) || cleaned == bucket_root {
        return Err("object path escapes bucket".into());
    }
    Ok(cleaned)
}

fn staging_dir_path(storage_dir: &str) -> PathBuf {
    FsPath::new(storage_dir).join(STAGING_SUBDIR)
}

/// Create (if needed) and return the reserved staging directory under
/// STORAGE_DIR. Both staging and the bucket-rooted finals are under STORAGE_DIR
/// so any rename between them stays on one filesystem (atomic on POSIX).
fn ensure_staging_dir(storage_dir: &str) -> std::io::Result<PathBuf> {
    let s = staging_dir_path(storage_dir);
    std::fs::create_dir_all(&s)?;
    Ok(s)
}

/// Remove leftover upload temp / backup files older than `min_age` from the
/// reserved staging directory ONLY (never the bucket namespace). Mirror of Go
/// `SweepDiskOrphans` (audit F1 round 20). All staging files have no DB row
/// pointing at them, so removal is safe; `min_age` avoids racing live uploads.
pub fn sweep_disk_orphans(storage_dir: &str, min_age: std::time::Duration) {
    if storage_dir.is_empty() {
        return;
    }
    let staging = staging_dir_path(storage_dir);
    let entries = match std::fs::read_dir(&staging) {
        Ok(e) => e,
        Err(_) => return, // staging dir not created yet — nothing to sweep
    };
    let cutoff = std::time::SystemTime::now() - min_age;
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let young = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|mtime| mtime > cutoff)
            .unwrap_or(true);
        if young {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        tracing::info!(
            removed,
            dir = %staging.display(),
            "storage: orphan sweep cleaned up stale staging/backup files"
        );
    }
}

/// Minimal subset of `net/http.DetectContentType`. Used only as a fallback when
/// the multipart part carries no (or octet-stream) Content-Type.
fn detect_content_type(data: &[u8]) -> &'static str {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        "image/gif"
    } else if data.starts_with(b"%PDF-") {
        "application/pdf"
    } else if data.starts_with(b"<?xml") {
        "text/xml; charset=utf-8"
    } else if data.starts_with(b"\x1f\x8b") {
        "application/x-gzip"
    } else if !data.is_empty() && data.iter().all(|&b| b >= 0x20 || b == b'\n' || b == b'\r' || b == b'\t') {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

/// True when `mime` is permitted by a bucket's `allowed_mime_types`. Empty list
/// = allow all. Supports exact, `*`, and `type/*` prefix matches (mirror Go).
fn mime_allowed(allowed: &[String], mime: &str) -> bool {
    if allowed.is_empty() {
        return true;
    }
    allowed.iter().any(|mt| {
        mt == mime
            || mt == "*"
            || (mt.ends_with("/*") && mime.starts_with(mt.trim_end_matches('*')))
    })
}

// ── bucket endpoints ────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateBucketBody {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    public: Option<bool>,
    file_size_limit: Option<i64>,
    #[serde(default)]
    allowed_mime_types: Vec<String>,
}

/// POST /storage/v1/bucket — create a bucket (service_role only).
pub async fn create_bucket(
    State(state): State<AppState>,
    claims: RequestClaims,
    Json(body): Json<CreateBucketBody>,
) -> Result<Response, AppError> {
    if claims.role != "service_role" {
        return Err(AppError::Forbidden(
            "bucket management requires service_role".into(),
        ));
    }

    let bucket_id = if !body.id.is_empty() { body.id } else { body.name };
    if bucket_id.is_empty() {
        return Err(AppError::BadRequest("bucket id or name is required".into()));
    }
    if !valid_bucket_id(&bucket_id) {
        return Err(AppError::BadRequest(
            "invalid bucket id: must match ^[a-z0-9][a-z0-9_-]{0,62}$ and not collide with internal names".into(),
        ));
    }

    let is_public = body.public.unwrap_or(false);
    let file_size_limit = body.file_size_limit.unwrap_or(DEFAULT_FILE_SIZE_LIMIT);

    let row = sqlx::query(&format!(
        "INSERT INTO pgstack.storage_buckets (id, public, file_size_limit, allowed_mime_types) \
         VALUES ($1, $2, $3, $4) RETURNING {TS_RFC3339} AS created_at"
    ))
    .bind(&bucket_id)
    .bind(is_public)
    .bind(file_size_limit)
    .bind(&body.allowed_mime_types)
    .fetch_one(&state.admin_pool)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
            AppError::Conflict(format!("bucket already exists: {bucket_id}"))
        }
        _ => {
            error!("storage: create bucket: {e}");
            AppError::Internal("internal database error".into())
        }
    })?;
    let created_at: String = row.get("created_at");

    let resp = serde_json::json!({
        "id": bucket_id,
        "public": is_public,
        "file_size_limit": file_size_limit,
        "allowed_mime_types": body.allowed_mime_types,
        "created_at": created_at,
    });
    Ok((StatusCode::CREATED, Json(resp)).into_response())
}

/// GET /storage/v1/bucket — list buckets (any authenticated principal).
pub async fn list_buckets(
    State(state): State<AppState>,
    _claims: RequestClaims,
) -> Result<Response, AppError> {
    let rows = sqlx::query(&format!(
        "SELECT id, public, file_size_limit, allowed_mime_types, {TS_RFC3339} AS created_at \
         FROM pgstack.storage_buckets ORDER BY created_at"
    ))
    .fetch_all(&state.admin_pool)
    .await
    .map_err(|e| {
        error!("storage: list buckets: {e}");
        AppError::Internal("internal database error".into())
    })?;

    let buckets: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let mimes: Option<Vec<String>> = r.get("allowed_mime_types");
            serde_json::json!({
                "id": r.get::<String, _>("id"),
                "public": r.get::<bool, _>("public"),
                "file_size_limit": r.get::<i64, _>("file_size_limit"),
                "allowed_mime_types": mimes.unwrap_or_default(),
                "created_at": r.get::<String, _>("created_at"),
            })
        })
        .collect();
    Ok(Json(buckets).into_response())
}

/// DELETE /storage/v1/bucket/{bucketId} — delete a bucket (service_role only).
pub async fn delete_bucket(
    State(state): State<AppState>,
    claims: RequestClaims,
    Path(bucket_id): Path<String>,
) -> Result<Response, AppError> {
    if claims.role != "service_role" {
        return Err(AppError::Forbidden(
            "bucket management requires service_role".into(),
        ));
    }
    if bucket_id.is_empty() {
        return Err(AppError::BadRequest("bucketId is required".into()));
    }

    let res = sqlx::query("DELETE FROM pgstack.storage_buckets WHERE id = $1")
        .bind(&bucket_id)
        .execute(&state.admin_pool)
        .await
        .map_err(|e| {
            error!("storage: delete bucket: {e}");
            AppError::Internal("internal database error".into())
        })?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("bucket not found: {bucket_id}")));
    }
    Ok(Json(serde_json::json!({ "message": "bucket deleted" })).into_response())
}

// ── object endpoints ────────────────────────────────────────────────────────

/// A bucket row (subset used by object handlers).
struct BucketRow {
    public: bool,
    file_size_limit: i64,
    allowed_mime_types: Vec<String>,
}

async fn get_bucket(state: &AppState, bucket_id: &str) -> Result<BucketRow, AppError> {
    let row = sqlx::query(
        "SELECT public, file_size_limit, allowed_mime_types \
         FROM pgstack.storage_buckets WHERE id = $1",
    )
    .bind(bucket_id)
    .fetch_optional(&state.admin_pool)
    .await
    .map_err(|e| {
        error!("storage: get bucket: {e}");
        AppError::Internal("internal database error".into())
    })?
    .ok_or_else(|| AppError::NotFound(format!("bucket not found: {bucket_id}")))?;
    let mimes: Option<Vec<String>> = row.get("allowed_mime_types");
    Ok(BucketRow {
        public: row.get("public"),
        file_size_limit: row.get("file_size_limit"),
        allowed_mime_types: mimes.unwrap_or_default(),
    })
}

/// POST /storage/v1/object/{bucket}/{*path} — upload an object.
/// multipart/form-data with a `file` field. Returns 200 `{id, key}`.
pub async fn upload_object(
    State(state): State<AppState>,
    claims: RequestClaims,
    Path((bucket_id, obj_name)): Path<(String, String)>,
    mut multipart: Multipart,
) -> Result<Response, AppError> {
    let obj_name = obj_name.trim_start_matches('/').to_string();
    if obj_name.is_empty() {
        return Err(AppError::BadRequest("object path is required".into()));
    }

    let bucket = get_bucket(&state, &bucket_id).await?;

    // Audit F4: anon uploads are refused for BOTH public and private buckets.
    // "public" authorises anon READ, never anon WRITE.
    if claims.role == "anon" {
        return Err(AppError::Forbidden("upload requires authentication".into()));
    }

    // Read the `file` part. The storage router's DefaultBodyLimit (MAX_FILE_SIZE
    // + 1 KB) caps the stream, mirroring Go's MaxBytesReader; over-limit reads
    // surface as a 413 here.
    let mut file_data: Option<Vec<u8>> = None;
    let mut part_mime: Option<String> = None;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    return Err(AppError::PayloadTooLarge(
                        "file size exceeds maximum upload limit".into(),
                    ));
                }
                return Err(AppError::BadRequest(
                    "file too large or invalid multipart form".into(),
                ));
            }
        };
        if field.name() == Some("file") {
            part_mime = field.content_type().map(|s| s.to_string());
            match field.bytes().await {
                Ok(b) => file_data = Some(b.to_vec()),
                Err(e) => {
                    if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
                        return Err(AppError::PayloadTooLarge(
                            "file size exceeds maximum upload limit".into(),
                        ));
                    }
                    return Err(AppError::BadRequest("failed to read file data".into()));
                }
            }
            break;
        }
    }
    let file_data = file_data
        .ok_or_else(|| AppError::BadRequest("missing 'file' field in multipart form".into()))?;

    let file_size = file_data.len() as i64;
    if bucket.file_size_limit > 0 && file_size > bucket.file_size_limit {
        return Err(AppError::PayloadTooLarge(format!(
            "file size {file_size} exceeds bucket limit {}",
            bucket.file_size_limit
        )));
    }

    // MIME: prefer the form part's Content-Type, fall back to sniffing.
    let mime_type = match part_mime.as_deref() {
        Some(m) if !m.is_empty() && m != "application/octet-stream" => m.to_string(),
        _ => detect_content_type(&file_data).to_string(),
    };
    if !mime_allowed(&bucket.allowed_mime_types, &mime_type) {
        return Err(AppError::BadRequest(format!(
            "mime type {mime_type} is not allowed in this bucket"
        )));
    }

    // Owner: anon is already refused; only service_role legitimately has no sub.
    let owner_id: Option<String> = claims.sub.clone();
    let is_service = claims.role == "service_role";

    let object_id = if state.config.storage_backend == "disk" {
        upload_disk(&state, &bucket_id, &obj_name, file_size, &mime_type, &owner_id, is_service, &file_data).await?
    } else {
        let sql = if is_service { UPSERT_DB_SERVICE_ROLE } else { UPSERT_DB_OWNER_LOCKED };
        let row = sqlx::query(sql)
            .bind(&bucket_id)
            .bind(&obj_name)
            .bind(file_size)
            .bind(&mime_type)
            .bind(&file_data)
            .bind(&owner_id)
            .fetch_optional(&state.admin_pool)
            .await
            .map_err(|e| {
                error!("storage: upload object: {e}");
                AppError::Internal("internal database error".into())
            })?;
        match row {
            Some(r) => r.get::<String, _>("id"),
            None => return Err(AppError::Forbidden("cannot overwrite another user's object".into())),
        }
    };

    Ok(Json(serde_json::json!({
        "id": object_id,
        "key": format!("{bucket_id}/{obj_name}"),
    }))
    .into_response())
}

/// Disk-backend upload: validate path, stage the bytes in the reserved staging
/// dir, claim the DB row in a tx (owner-locked), then atomically rename the
/// staged file into place and commit. A failure path rolls back the tx and
/// removes the staged file (no orphan, no half-written final). Mirror of Go's
/// stage-then-rename flow (audit F1 rounds 15-20), minus the per-key advisory
/// lock (the owner-locked SQL + UNIQUE(bucket,name) already serialise the row;
/// the tx keeps DB and FS consistent).
#[allow(clippy::too_many_arguments)]
async fn upload_disk(
    state: &AppState,
    bucket_id: &str,
    obj_name: &str,
    file_size: i64,
    mime_type: &str,
    owner_id: &Option<String>,
    is_service: bool,
    file_data: &[u8],
) -> Result<String, AppError> {
    let dir = &state.config.storage_dir;
    let disk_path =
        safe_storage_path(dir, bucket_id, obj_name).map_err(AppError::BadRequest)?;
    if let Some(parent) = disk_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            error!("storage: mkdir for disk upload: {e}");
            return Err(AppError::Internal("failed to create storage directory".into()));
        }
    }
    // Stage the file in the reserved staging dir.
    let staging = ensure_staging_dir(dir).map_err(|e| {
        error!("storage: prepare staging dir: {e}");
        AppError::Internal("failed to prepare staging area".into())
    })?;
    let tmp_path = staging.join(format!("upload-{}", uuid::Uuid::new_v4()));
    if let Err(e) = std::fs::write(&tmp_path, file_data) {
        error!("storage: write temp file: {e}");
        return Err(AppError::Internal("failed to stage upload".into()));
    }
    // From here on, ensure the staged file is removed unless rename consumes it.
    let cleanup_tmp = |p: &PathBuf| {
        let _ = std::fs::remove_file(p);
    };

    let mut tx = match state.admin_pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            cleanup_tmp(&tmp_path);
            error!("storage: begin upload tx: {e}");
            return Err(AppError::Internal("internal database error".into()));
        }
    };
    let sql = if is_service { UPSERT_DISK_SERVICE_ROLE } else { UPSERT_DISK_OWNER_LOCKED };
    let row = sqlx::query(sql)
        .bind(bucket_id)
        .bind(obj_name)
        .bind(file_size)
        .bind(mime_type)
        .bind(owner_id)
        .fetch_optional(&mut *tx)
        .await;
    let object_id = match row {
        Ok(Some(r)) => r.get::<String, _>("id"),
        Ok(None) => {
            cleanup_tmp(&tmp_path);
            return Err(AppError::Forbidden("cannot overwrite another user's object".into()));
        }
        Err(e) => {
            cleanup_tmp(&tmp_path);
            error!("storage: upload object: {e}");
            return Err(AppError::Internal("internal database error".into()));
        }
    };

    // Promote the staged file into its final location. If this fails the tx
    // rolls back on drop, so metadata stays consistent with the (unchanged) FS.
    if let Err(e) = std::fs::rename(&tmp_path, &disk_path) {
        cleanup_tmp(&tmp_path);
        error!("storage: promote staged upload — rolling back tx: {e}");
        return Err(AppError::Internal("failed to finalise upload".into()));
    }
    if let Err(e) = tx.commit().await {
        // Rename already happened; the row is rolled back. Remove the new file
        // so a retry sees a clean slate (no row points at it).
        let _ = std::fs::remove_file(&disk_path);
        error!("storage: commit upload after rename: {e}");
        return Err(AppError::Internal("failed to finalise upload".into()));
    }
    Ok(object_id)
}

/// GET /storage/v1/object/{bucket}/{*path} — download an object.
pub async fn download_object(
    State(state): State<AppState>,
    claims: RequestClaims,
    Path((bucket_id, obj_name)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let obj_name = obj_name.trim_start_matches('/').to_string();
    if obj_name.is_empty() {
        return Err(AppError::BadRequest("object path is required".into()));
    }

    let bucket = get_bucket(&state, &bucket_id).await?;

    let row = sqlx::query(
        "SELECT mime_type, size, COALESCE(owner::text, '') AS owner, data \
         FROM pgstack.storage_objects WHERE bucket_id = $1 AND name = $2",
    )
    .bind(&bucket_id)
    .bind(&obj_name)
    .fetch_optional(&state.admin_pool)
    .await
    .map_err(|e| {
        error!(bucket = %bucket_id, object = %obj_name, "storage: download query: {e}");
        AppError::Internal("internal database error".into())
    })?
    .ok_or_else(|| AppError::NotFound("object not found".into()))?;

    let mime_type: Option<String> = row.get("mime_type");
    let mime_type = mime_type.unwrap_or_else(|| "application/octet-stream".into());
    let size: i64 = row.get("size");
    let owner_str: String = row.get("owner");
    let mut data: Option<Vec<u8>> = row.get("data");

    // Access control. Public bucket → anyone reads. Private → auth + owner or
    // service_role (SECURITY.md storage surface; init.sql storage RLS mirror).
    if !bucket.public {
        if claims.role == "anon" {
            return Err(AppError::Forbidden("access denied to private bucket".into()));
        }
        if claims.role != "service_role" && claims.sub.as_deref() != Some(owner_str.as_str()) {
            return Err(AppError::Forbidden(
                "access denied: not the object owner".into(),
            ));
        }
    }

    // Disk backend: bytes live on the filesystem (data column is NULL).
    if state.config.storage_backend == "disk" && data.is_none() {
        let disk_path =
            safe_storage_path(&state.config.storage_dir, &bucket_id, &obj_name).map_err(AppError::BadRequest)?;
        match std::fs::read(&disk_path) {
            Ok(b) => data = Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(AppError::NotFound("file not found on disk".into()));
            }
            Err(e) => {
                error!(path = %disk_path.display(), "storage: disk read: {e}");
                return Err(AppError::Internal("failed to read file from disk".into()));
            }
        }
    }
    let data = data.unwrap_or_default();

    let filename = obj_name.rsplit('/').next().unwrap_or(&obj_name);
    let safe_name = filename.replace('\\', "\\\\").replace('"', "\\\"");
    let cache = if bucket.public {
        "public, max-age=3600"
    } else {
        "private, no-store"
    };

    let resp = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_type)
        .header(header::CONTENT_LENGTH, size.to_string())
        .header(
            header::CONTENT_DISPOSITION,
            format!("inline; filename=\"{safe_name}\""),
        )
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(data))
        .map_err(|e| {
            error!("storage: build download response: {e}");
            AppError::Internal("internal error".into())
        })?;
    Ok(resp)
}

/// DELETE /storage/v1/object/{bucket}/{*path} — delete an object.
pub async fn delete_object(
    State(state): State<AppState>,
    claims: RequestClaims,
    Path((bucket_id, obj_name)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let obj_name = obj_name.trim_start_matches('/').to_string();
    if obj_name.is_empty() {
        return Err(AppError::BadRequest("object path is required".into()));
    }

    let _bucket = get_bucket(&state, &bucket_id).await?;

    // anon cannot delete; authenticated deletes own objects; service_role any.
    if claims.role == "anon" {
        return Err(AppError::Forbidden("delete requires authentication".into()));
    }

    let disk = state.config.storage_backend == "disk";

    // Disk backend: stage the file aside under a tx BEFORE commit so a
    // concurrent upload after commit can't have its new file removed; then
    // remove only our staged copy (mirror Go round 20). DB backend: plain DML.
    let mut tx = if disk {
        Some(state.admin_pool.begin().await.map_err(|e| {
            error!("storage: begin delete tx: {e}");
            AppError::Internal("internal database error".into())
        })?)
    } else {
        None
    };

    let rows_affected = if claims.role == "service_role" {
        let q = sqlx::query("DELETE FROM pgstack.storage_objects WHERE bucket_id = $1 AND name = $2")
            .bind(&bucket_id)
            .bind(&obj_name);
        match tx.as_mut() {
            Some(t) => q.execute(&mut **t).await,
            None => q.execute(&state.admin_pool).await,
        }
    } else {
        let q = sqlx::query(
            "DELETE FROM pgstack.storage_objects WHERE bucket_id = $1 AND name = $2 AND owner = $3::uuid",
        )
        .bind(&bucket_id)
        .bind(&obj_name)
        .bind(&claims.sub);
        match tx.as_mut() {
            Some(t) => q.execute(&mut **t).await,
            None => q.execute(&state.admin_pool).await,
        }
    }
    .map_err(|e| {
        error!("storage: delete object: {e}");
        AppError::Internal("internal database error".into())
    })?
    .rows_affected();

    if rows_affected == 0 {
        return Err(AppError::NotFound("object not found or access denied".into()));
    }

    if let Some(tx) = tx {
        let mut backup: Option<PathBuf> = None;
        let disk_path =
            safe_storage_path(&state.config.storage_dir, &bucket_id, &obj_name).map_err(AppError::BadRequest)?;
        match std::fs::metadata(&disk_path) {
            Ok(_) => {
                let staging = ensure_staging_dir(&state.config.storage_dir).map_err(|e| {
                    error!("storage: prepare staging dir for delete: {e}");
                    AppError::Internal("failed to stage delete".into())
                })?;
                let bk = staging.join(format!("backup-{}", uuid::Uuid::new_v4()));
                if let Err(e) = std::fs::rename(&disk_path, &bk) {
                    error!("storage: stage file for delete: {e}");
                    return Err(AppError::Internal("failed to stage delete".into()));
                }
                backup = Some(bk);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // nothing on disk
            Err(e) => {
                error!(path = %disk_path.display(), "storage: stat for delete: {e}");
                return Err(AppError::Internal("failed to stat object on disk".into()));
            }
        }
        if let Err(e) = tx.commit().await {
            // Restore the staged file so the (rolled-back) row again points at bytes.
            if let Some(bk) = &backup {
                let _ = std::fs::rename(bk, &disk_path);
            }
            error!("storage: commit delete: {e}");
            return Err(AppError::Internal("internal database error".into()));
        }
        if let Some(bk) = backup {
            let _ = std::fs::remove_file(bk); // remove OUR staged copy only
        }
    }

    Ok(Json(serde_json::json!({ "message": "object deleted" })).into_response())
}

#[derive(Deserialize)]
pub struct ListObjectsQuery {
    #[serde(default)]
    prefix: String,
}

/// GET /storage/v1/object/list/{bucket} — list objects, optional ?prefix=.
pub async fn list_objects(
    State(state): State<AppState>,
    claims: RequestClaims,
    Path(bucket_id): Path<String>,
    Query(q): Query<ListObjectsQuery>,
) -> Result<Response, AppError> {
    let bucket = get_bucket(&state, &bucket_id).await?;

    // Private bucket: anon cannot list.
    if !bucket.public && claims.role == "anon" {
        return Err(AppError::Forbidden("access denied to private bucket".into()));
    }

    let cols = format!("id::text, name, size, mime_type, {TS_RFC3339} AS created_at");
    let have_prefix = !q.prefix.is_empty();

    // Private + non-service_role: restrict to the caller's own objects.
    let restrict_owner = !bucket.public && claims.role != "service_role";

    let mut builder = sqlx::QueryBuilder::<sqlx::Postgres>::new(format!(
        "SELECT {cols} FROM pgstack.storage_objects WHERE bucket_id = "
    ));
    builder.push_bind(&bucket_id);
    if have_prefix {
        builder.push(" AND name LIKE ").push_bind(&q.prefix).push(" || '%'");
    }
    if restrict_owner {
        builder.push(" AND owner = ").push_bind(&claims.sub).push("::uuid");
    }
    builder.push(" ORDER BY name");

    let rows = builder
        .build()
        .fetch_all(&state.admin_pool)
        .await
        .map_err(|e| {
            error!("storage: list objects: {e}");
            AppError::Internal("internal database error".into())
        })?;

    let objects: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let mime: Option<String> = r.get("mime_type");
            serde_json::json!({
                "id": r.get::<String, _>("id"),
                "name": r.get::<String, _>("name"),
                "size": r.get::<i64, _>("size"),
                "mime_type": mime.unwrap_or_default(),
                "created_at": r.get::<String, _>("created_at"),
            })
        })
        .collect();
    Ok(Json(objects).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_id_rules() {
        for ok in ["avatars", "a", "a-b_c", "bucket0", "x".repeat(63).as_str()] {
            assert!(valid_bucket_id(ok), "{ok:?} should be valid");
        }
        for bad in [
            "",
            "-leading",
            "_leading",
            "UPPER",
            "has.dot",
            "has/slash",
            "has space",
            ".pgstack-staging",
            "x".repeat(64).as_str(),
        ] {
            assert!(!valid_bucket_id(bad), "{bad:?} should be invalid");
        }
    }

    #[test]
    fn safe_path_allows_clean_relative() {
        let p = safe_storage_path("/storage", "avatars", "user/42/pic.png").unwrap();
        assert!(p.ends_with("avatars/user/42/pic.png") || p.ends_with("avatars\\user\\42\\pic.png"));
    }

    #[test]
    fn safe_path_rejects_traversal() {
        for name in [
            "../etc/passwd",
            "../../etc/passwd",
            "a/../../../etc/passwd",
            "./../escape",
            "a/b/../../../escape",
        ] {
            assert!(
                safe_storage_path("/storage", "bucket", name).is_err(),
                "{name:?} must be rejected"
            );
        }
    }

    #[test]
    fn safe_path_rejects_absolute_and_drive_and_unc() {
        for name in [
            "/etc/passwd",
            "\\Windows\\System32\\cmd.exe",
            "C:\\Windows\\System32\\cmd.exe",
            "\\\\server\\share\\file",
            "D:/secret",
        ] {
            assert!(
                safe_storage_path("/storage", "bucket", name).is_err(),
                "{name:?} must be rejected"
            );
        }
    }

    #[test]
    fn safe_path_rejects_invalid_bucket_and_empty_and_nul() {
        for b in ["..", "a/b", "a\\b", "../foo"] {
            assert!(safe_storage_path("/storage", b, "ok.txt").is_err(), "bucket {b:?}");
        }
        assert!(safe_storage_path("", "b", "o").is_err());
        assert!(safe_storage_path("/storage", "", "o").is_err());
        assert!(safe_storage_path("/storage", "b", "").is_err());
        assert!(safe_storage_path("/storage", "b", "ok\0.txt").is_err());
    }

    #[test]
    fn mime_matching() {
        assert!(mime_allowed(&[], "anything/here"));
        assert!(mime_allowed(&["image/png".into()], "image/png"));
        assert!(!mime_allowed(&["image/png".into()], "image/jpeg"));
        assert!(mime_allowed(&["*".into()], "x/y"));
        assert!(mime_allowed(&["image/*".into()], "image/gif"));
        assert!(!mime_allowed(&["image/*".into()], "text/plain"));
    }

    #[test]
    fn content_type_sniffing() {
        assert_eq!(detect_content_type(b"\x89PNG\r\n\x1a\n..."), "image/png");
        assert_eq!(detect_content_type(&[0xFF, 0xD8, 0xFF, 0x00]), "image/jpeg");
        assert_eq!(detect_content_type(b"%PDF-1.7"), "application/pdf");
        assert_eq!(detect_content_type(b"hello world"), "text/plain; charset=utf-8");
        assert_eq!(detect_content_type(&[0x00, 0x01, 0x02]), "application/octet-stream");
    }
}
