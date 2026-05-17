package routes

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"pgstack-proxy-go/middleware"
)

// StorageDeps carries the dependencies needed by all storage handlers.
type StorageDeps struct {
	Pool           *pgxpool.Pool
	ResolveClaims  func(r *http.Request) (middleware.RequestClaims, error)
	MaxFileSize    int64  // default 50 MB
	StorageBackend string // "database" (default) or "disk"
	StorageDir     string // filesystem path for disk backend
}

// Atomic owner-locked upserts (audit F1, round 14; metadata snapshot
// added round 16 for fine-grained rollback). The WHERE clause on the
// UPDATE branch refuses ownership transfer: a concurrent first-write race
// or a deliberate overwrite by a different user produces 0 rows in
// RETURNING, which the caller maps to HTTP 403. Owner is intentionally
// omitted from the UPDATE SET — the gate already proved the owner matches
// EXCLUDED.owner, so re-setting it is a no-op.
//
// Round 16: each variant now returns (id, inserted, prev_size, prev_mime).
// `inserted` (via xmax = 0) lets the caller distinguish a fresh INSERT
// from an UPDATE. prev_size/prev_mime are NULL on INSERT and carry the
// PRE-UPDATE values on UPDATE (captured via a CTE that snapshots the row
// before the upsert touches it). If the post-claim disk rename fails, the
// caller can compensate precisely: DELETE when inserted, restore the
// previous metadata when updated. Without that flag the previous blanket
// DELETE would have silently wiped a same-owner / service_role overwrite
// of an existing object whose original file on disk was still intact.
const (
	upsertObjectDBOwnerLocked = `
		WITH prev AS (
			SELECT size, mime_type FROM pgstack.storage_objects
			WHERE bucket_id = $1 AND name = $2
		)
		INSERT INTO pgstack.storage_objects (bucket_id, name, size, mime_type, data, owner)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (bucket_id, name) DO UPDATE
		   SET size = EXCLUDED.size,
		       mime_type = EXCLUDED.mime_type,
		       data = EXCLUDED.data,
		       updated_at = now()
		   WHERE pgstack.storage_objects.owner IS NOT DISTINCT FROM EXCLUDED.owner
		RETURNING id::text,
		          (xmax = 0) AS inserted,
		          (SELECT size      FROM prev) AS prev_size,
		          (SELECT mime_type FROM prev) AS prev_mime`

	upsertObjectDiskOwnerLocked = `
		WITH prev AS (
			SELECT size, mime_type FROM pgstack.storage_objects
			WHERE bucket_id = $1 AND name = $2
		)
		INSERT INTO pgstack.storage_objects (bucket_id, name, size, mime_type, data, owner)
		VALUES ($1, $2, $3, $4, NULL, $5)
		ON CONFLICT (bucket_id, name) DO UPDATE
		   SET size = EXCLUDED.size,
		       mime_type = EXCLUDED.mime_type,
		       data = NULL,
		       updated_at = now()
		   WHERE pgstack.storage_objects.owner IS NOT DISTINCT FROM EXCLUDED.owner
		RETURNING id::text,
		          (xmax = 0) AS inserted,
		          (SELECT size      FROM prev) AS prev_size,
		          (SELECT mime_type FROM prev) AS prev_mime`

	// service_role bypasses the owner gate (admin overwrite). Owner column
	// is preserved on overwrite — an admin re-upload does not silently
	// reassign ownership to a service-role principal.
	upsertObjectDBServiceRole = `
		WITH prev AS (
			SELECT size, mime_type FROM pgstack.storage_objects
			WHERE bucket_id = $1 AND name = $2
		)
		INSERT INTO pgstack.storage_objects (bucket_id, name, size, mime_type, data, owner)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (bucket_id, name) DO UPDATE
		   SET size = EXCLUDED.size,
		       mime_type = EXCLUDED.mime_type,
		       data = EXCLUDED.data,
		       updated_at = now()
		RETURNING id::text,
		          (xmax = 0) AS inserted,
		          (SELECT size      FROM prev) AS prev_size,
		          (SELECT mime_type FROM prev) AS prev_mime`

	upsertObjectDiskServiceRole = `
		WITH prev AS (
			SELECT size, mime_type FROM pgstack.storage_objects
			WHERE bucket_id = $1 AND name = $2
		)
		INSERT INTO pgstack.storage_objects (bucket_id, name, size, mime_type, data, owner)
		VALUES ($1, $2, $3, $4, NULL, $5)
		ON CONFLICT (bucket_id, name) DO UPDATE
		   SET size = EXCLUDED.size,
		       mime_type = EXCLUDED.mime_type,
		       data = NULL,
		       updated_at = now()
		RETURNING id::text,
		          (xmax = 0) AS inserted,
		          (SELECT size      FROM prev) AS prev_size,
		          (SELECT mime_type FROM prev) AS prev_mime`

)

// storageResolveClaims is a shorthand used by storage handlers. It returns
// claims + writes an error response on failure.
func storageResolveClaims(d *StorageDeps, w http.ResponseWriter, r *http.Request) (middleware.RequestClaims, bool) {
	claims, err := d.ResolveClaims(r)
	if err != nil {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return middleware.RequestClaims{}, false
	}
	return claims, true
}

// ---- Bucket endpoints ----

// bucketResponse is the JSON representation of a storage bucket.
type bucketResponse struct {
	ID               string   `json:"id"`
	Public           bool     `json:"public"`
	FileSizeLimit    int64    `json:"file_size_limit"`
	AllowedMimeTypes []string `json:"allowed_mime_types"`
	CreatedAt        string   `json:"created_at"`
}

// CreateBucket handles POST /storage/v1/bucket.
// Restricted to service_role.
func CreateBucket(d *StorageDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := storageResolveClaims(d, w, r)
		if !ok {
			return
		}
		if claims.Role != "service_role" {
			writeJSONError(w, http.StatusForbidden, "bucket management requires service_role")
			return
		}

		var body struct {
			ID               string   `json:"id"`
			Name             string   `json:"name"`
			Public           *bool    `json:"public"`
			FileSizeLimit    *int64   `json:"file_size_limit"`
			AllowedMimeTypes []string `json:"allowed_mime_types"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}

		bucketID := body.ID
		if bucketID == "" {
			bucketID = body.Name
		}
		if bucketID == "" {
			writeJSONError(w, http.StatusBadRequest, "bucket id or name is required")
			return
		}

		isPublic := false
		if body.Public != nil {
			isPublic = *body.Public
		}
		fileSizeLimit := int64(52428800) // 50 MB
		if body.FileSizeLimit != nil {
			fileSizeLimit = *body.FileSizeLimit
		}

		var createdAt time.Time
		err := d.Pool.QueryRow(r.Context(),
			`INSERT INTO pgstack.storage_buckets (id, public, file_size_limit, allowed_mime_types)
			 VALUES ($1, $2, $3, $4)
			 RETURNING created_at`,
			bucketID, isPublic, fileSizeLimit, body.AllowedMimeTypes,
		).Scan(&createdAt)
		if err != nil {
			code := pgErrCode(err)
			if code == "23505" {
				writeJSONError(w, http.StatusConflict, "bucket already exists: "+bucketID)
				return
			}
			log.Error().Err(err).Msg("storage: create bucket")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(bucketResponse{
			ID:               bucketID,
			Public:           isPublic,
			FileSizeLimit:    fileSizeLimit,
			AllowedMimeTypes: body.AllowedMimeTypes,
			CreatedAt:        createdAt.Format(time.RFC3339),
		})
	}
}

// ListBuckets handles GET /storage/v1/bucket.
func ListBuckets(d *StorageDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_, ok := storageResolveClaims(d, w, r)
		if !ok {
			return
		}

		rows, err := d.Pool.Query(r.Context(),
			`SELECT id, public, file_size_limit, allowed_mime_types, created_at
			 FROM pgstack.storage_buckets ORDER BY created_at`)
		if err != nil {
			log.Error().Err(err).Msg("storage: list buckets")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}
		defer rows.Close()

		buckets := make([]bucketResponse, 0)
		for rows.Next() {
			var b bucketResponse
			var mimeTypes []string
			var createdAt time.Time
			if err := rows.Scan(&b.ID, &b.Public, &b.FileSizeLimit, &mimeTypes, &createdAt); err != nil {
				log.Error().Err(err).Msg("storage: scan bucket row")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}
			b.AllowedMimeTypes = mimeTypes
			b.CreatedAt = createdAt.Format(time.RFC3339)
			buckets = append(buckets, b)
		}
		if err := rows.Err(); err != nil {
			log.Error().Err(err).Msg("storage: list buckets iteration")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(buckets)
	}
}

// DeleteBucket handles DELETE /storage/v1/bucket/{bucketId}.
// Restricted to service_role.
func DeleteBucket(d *StorageDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := storageResolveClaims(d, w, r)
		if !ok {
			return
		}
		if claims.Role != "service_role" {
			writeJSONError(w, http.StatusForbidden, "bucket management requires service_role")
			return
		}

		bucketID := chi.URLParam(r, "bucketId")
		if bucketID == "" {
			writeJSONError(w, http.StatusBadRequest, "bucketId is required")
			return
		}

		tag, err := d.Pool.Exec(r.Context(),
			`DELETE FROM pgstack.storage_buckets WHERE id = $1`, bucketID)
		if err != nil {
			log.Error().Err(err).Msg("storage: delete bucket")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}
		if tag.RowsAffected() == 0 {
			writeJSONError(w, http.StatusNotFound, "bucket not found: "+bucketID)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "bucket deleted"})
	}
}

// ---- Object endpoints ----

// objectPath extracts the wildcard path portion after /object/{bucket}/.
func objectPath(r *http.Request) string {
	p := chi.URLParam(r, "*")
	// chi returns the path without leading slash
	return strings.TrimLeft(p, "/")
}

// safeStoragePath joins root + bucketID + objName and guarantees the resolved
// absolute path stays inside root. Rejects:
//   - empty bucketID/objName
//   - absolute objName (POSIX leading slash, Windows drive letter, UNC)
//   - any traversal that resolves outside root (.., URL-encoded variants land
//     here too because chi already URL-decodes the wildcard)
//
// Returns the cleaned absolute path, or "" + error suitable for a 400 response.
func safeStoragePath(root, bucketID, objName string) (string, error) {
	if root == "" {
		return "", fmt.Errorf("storage root not configured")
	}
	if bucketID == "" || objName == "" {
		return "", fmt.Errorf("bucket and object are required")
	}
	// Reject obvious shapes before letting filepath touch them.
	if filepath.IsAbs(objName) || strings.HasPrefix(objName, "/") ||
		strings.HasPrefix(objName, `\`) || strings.Contains(objName, `\\`) {
		return "", fmt.Errorf("object path must be relative")
	}
	// Defence-in-depth: forbid drive letters and NUL even on POSIX builds.
	if len(objName) >= 2 && objName[1] == ':' {
		return "", fmt.Errorf("object path must be relative")
	}
	if strings.ContainsRune(objName, 0) {
		return "", fmt.Errorf("object path contains NUL")
	}
	// Same rules for bucketID — it is DB-validated today, but treat user input
	// as user input.
	if strings.ContainsAny(bucketID, `/\`) || strings.Contains(bucketID, "..") {
		return "", fmt.Errorf("invalid bucket id")
	}

	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("storage root unresolvable: %w", err)
	}
	bucketRoot := filepath.Join(absRoot, bucketID)
	cleaned := filepath.Clean(filepath.Join(bucketRoot, objName))

	// Require cleaned path to live under the bucket's own subtree — escaping
	// into a sibling bucket is just as bad as escaping the root entirely.
	rel, err := filepath.Rel(bucketRoot, cleaned)
	if err != nil {
		return "", fmt.Errorf("invalid object path")
	}
	if rel == "." || rel == ".." ||
		strings.HasPrefix(rel, ".."+string(filepath.Separator)) ||
		filepath.IsAbs(rel) {
		return "", fmt.Errorf("object path escapes bucket")
	}
	return cleaned, nil
}

// objectListItem is a single object in a list response (no data field).
type objectListItem struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	MimeType  string `json:"mime_type"`
	CreatedAt string `json:"created_at"`
}

// uploadResponse is the JSON response after a successful upload.
type uploadResponse struct {
	ID  string `json:"id"`
	Key string `json:"key"`
}

// getBucket fetches a bucket row. Returns nil if not found (writes 404).
type bucketRow struct {
	ID               string
	Public           bool
	FileSizeLimit    int64
	AllowedMimeTypes []string
}

func getBucket(d *StorageDeps, w http.ResponseWriter, r *http.Request, bucketID string) *bucketRow {
	var b bucketRow
	err := d.Pool.QueryRow(r.Context(),
		`SELECT id, public, file_size_limit, allowed_mime_types
		 FROM pgstack.storage_buckets WHERE id = $1`, bucketID,
	).Scan(&b.ID, &b.Public, &b.FileSizeLimit, &b.AllowedMimeTypes)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONError(w, http.StatusNotFound, "bucket not found: "+bucketID)
		} else {
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
		}
		return nil
	}
	return &b
}

// UploadObject handles POST /storage/v1/object/{bucket}/*.
// Accepts multipart/form-data with a "file" field.
func UploadObject(d *StorageDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := storageResolveClaims(d, w, r)
		if !ok {
			return
		}

		bucketID := chi.URLParam(r, "bucket")
		objName := objectPath(r)
		if objName == "" {
			writeJSONError(w, http.StatusBadRequest, "object path is required")
			return
		}

		bucket := getBucket(d, w, r, bucketID)
		if bucket == nil {
			return
		}

		// Audit F4 closure: anon uploads are refused for both public and
		// private buckets. A "public" bucket means anyone can READ; it does
		// not authorise unauthenticated writes. Anon-writable storage is a
		// classic abuse vector (spam hosting, malware delivery, deface).
		// Allow only authenticated users or service_role to upload anywhere.
		if claims.Role == "anon" {
			writeJSONError(w, http.StatusForbidden, "upload requires authentication")
			return
		}

		// Parse multipart form (limit to configured max + 1 KB overhead for headers)
		maxSize := d.MaxFileSize
		if maxSize <= 0 {
			maxSize = 52428800 // 50 MB default
		}
		if bucket.FileSizeLimit > 0 && bucket.FileSizeLimit < maxSize {
			maxSize = bucket.FileSizeLimit
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxSize+1024)
		if err := r.ParseMultipartForm(maxSize); err != nil {
			writeJSONError(w, http.StatusBadRequest, "file too large or invalid multipart form")
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "missing 'file' field in multipart form")
			return
		}
		defer file.Close()

		fileData, err := io.ReadAll(file)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "failed to read file data")
			return
		}

		fileSize := int64(len(fileData))
		if bucket.FileSizeLimit > 0 && fileSize > bucket.FileSizeLimit {
			writeJSONError(w, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("file size %d exceeds bucket limit %d", fileSize, bucket.FileSizeLimit))
			return
		}

		// Detect MIME type: prefer Content-Type from the form part, fall back to
		// sniffing the first 512 bytes.
		mimeType := header.Header.Get("Content-Type")
		if mimeType == "" || mimeType == "application/octet-stream" {
			mimeType = http.DetectContentType(fileData)
		}

		// Validate allowed MIME types
		if len(bucket.AllowedMimeTypes) > 0 {
			allowed := false
			for _, mt := range bucket.AllowedMimeTypes {
				if mt == mimeType || mt == "*" ||
				(strings.HasSuffix(mt, "/*") && strings.HasPrefix(mimeType, strings.TrimSuffix(mt, "*"))) {
					allowed = true
					break
				}
			}
			if !allowed {
				writeJSONError(w, http.StatusBadRequest,
					fmt.Sprintf("mime type %s is not allowed in this bucket", mimeType))
				return
			}
		}

		// Determine owner UUID (anon is already refused above; only
		// service_role can legitimately end up with claims.Sub == "").
		var ownerID *string
		if claims.Sub != "" {
			ownerID = &claims.Sub
		}

		// Audit F1 (round 14): the previous SELECT-then-INSERT-ON-CONFLICT
		// pattern is racy on first-write. Two parallel POSTs for a new
		// bucket/name pair both pass the SELECT (no row yet), then one ON
		// CONFLICT DO UPDATE silently overwrites the other's owner. Replaced
		// with a single atomic statement: the UPDATE branch only fires when
		// the existing row's owner already matches EXCLUDED.owner. A row
		// claimed by user A but UPDATEd by user B yields 0 rows in the
		// RETURNING — we detect that and refuse with 403. service_role
		// gets a separate path that may overwrite anyone (admin case);
		// owner is preserved on overwrite so an admin re-upload does not
		// silently reassign ownership.
		// Audit F1 (round 15): for the disk backend, validate the path and
		// pre-stage the file BEFORE the DB claim, then on success rename
		// the temp file into place atomically. If WriteFile/MkdirAll fail
		// after the DB claim there is no way to roll back PG cleanly inside
		// a serverless flow — the only safe sequencing is: file-side errors
		// happen before the row exists; DB-side errors happen before the
		// file moves into place. This eliminates the previous orphan
		// scenarios (invalid path → 400 left a metadata row; WriteFile
		// failure same). For overwrites the same-owner check still gates
		// the DB UPDATE, so two parallel writes by different users cannot
		// race the file rename.
		var (
			diskPath string
			tmpPath  string
		)
		if d.StorageBackend == "disk" {
			var perr error
			diskPath, perr = safeStoragePath(d.StorageDir, bucketID, objName)
			if perr != nil {
				writeJSONError(w, http.StatusBadRequest, perr.Error())
				return
			}
			if err := os.MkdirAll(filepath.Dir(diskPath), 0o755); err != nil {
				log.Error().Err(err).Str("path", diskPath).Msg("storage: mkdir for disk upload")
				writeJSONError(w, http.StatusInternalServerError, "failed to create storage directory")
				return
			}
			tmp, terr := os.CreateTemp(filepath.Dir(diskPath), ".pgstack-upload-*")
			if terr != nil {
				log.Error().Err(terr).Str("dir", filepath.Dir(diskPath)).Msg("storage: open temp file")
				writeJSONError(w, http.StatusInternalServerError, "failed to stage upload")
				return
			}
			tmpPath = tmp.Name()
			// On any early return below, clean up the staged file. If we
			// successfully rename, this delete becomes a no-op.
			defer func() {
				if tmpPath != "" {
					_ = os.Remove(tmpPath)
				}
			}()
			if _, werr := tmp.Write(fileData); werr != nil {
				_ = tmp.Close()
				log.Error().Err(werr).Str("path", tmpPath).Msg("storage: write temp file")
				writeJSONError(w, http.StatusInternalServerError, "failed to stage upload")
				return
			}
			if cerr := tmp.Close(); cerr != nil {
				log.Error().Err(cerr).Str("path", tmpPath).Msg("storage: close temp file")
				writeJSONError(w, http.StatusInternalServerError, "failed to stage upload")
				return
			}
		}

		var objectID string

		if d.StorageBackend == "disk" {
			// Audit F1 (round 17): serialize per-(bucket,name) so that two
			// concurrent same-owner / service_role overwrites cannot
			// interleave as DB(A→B) + rename(B→A) and leave the row's
			// metadata describing B while the file on disk is A's bytes.
			//
			// Strategy: open a tx, take an xact-scoped advisory lock keyed
			// by hashtext(bucket)/hashtext(name), do the upsert + rename
			// inside the tx, and either commit (releases lock) or rollback
			// (which undoes the INSERT/UPDATE — no manual compensation
			// needed). Two parallel uploads to the same key now run
			// strictly sequentially and the (DB, FS) pair is always
			// consistent.
			tx, err := d.Pool.Begin(r.Context())
			if err != nil {
				log.Error().Err(err).Msg("storage: begin upload tx")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}
			// Default to rollback; replaced by an explicit Commit on the
			// happy path. Rollback after a successful Commit is a no-op.
			committed := false
			defer func() {
				if !committed {
					_ = tx.Rollback(r.Context())
				}
			}()

			if _, err := tx.Exec(r.Context(),
				`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
				bucketID, objName,
			); err != nil {
				log.Error().Err(err).Msg("storage: acquire per-key advisory lock")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}

			var (
				inserted bool
				prevSize *int64
				prevMime *string
				scanErr  error
			)
			if claims.Role == "service_role" {
				scanErr = tx.QueryRow(r.Context(), upsertObjectDiskServiceRole,
					bucketID, objName, fileSize, mimeType, ownerID,
				).Scan(&objectID, &inserted, &prevSize, &prevMime)
			} else {
				scanErr = tx.QueryRow(r.Context(), upsertObjectDiskOwnerLocked,
					bucketID, objName, fileSize, mimeType, ownerID,
				).Scan(&objectID, &inserted, &prevSize, &prevMime)
			}
			if errors.Is(scanErr, pgx.ErrNoRows) {
				writeJSONError(w, http.StatusForbidden, "cannot overwrite another user's object")
				return
			}
			if scanErr != nil {
				log.Error().Err(scanErr).Msg("storage: upload object")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}
			// Suppress unused-warning for the snapshot vars — they are
			// part of the SQL contract (kept for any future compensation
			// path) but not consulted on the rollback-based flow.
			_, _ = inserted, prevSize
			_ = prevMime

			// Audit F1 (round 18): for the rare but real case where
			// os.Rename succeeds and tx.Commit then fails, the previous
			// strategy was to os.Remove(diskPath) — but for an overwrite
			// that destroys the previous file too, while DB rollback
			// restores the previous metadata. Net effect: row points at a
			// file that no longer exists.
			//
			// Backup the existing file (if any) under the same advisory
			// lock so we can restore it on any post-stage failure. The
			// backup lives in the same directory as the target so the
			// final rename / restore are guaranteed to be same-fs (and
			// therefore atomic on POSIX). The backup is cleaned up on
			// the happy path; on failure paths it is rolled back into
			// place over whatever is currently at diskPath.
			var backupPath string
			if _, statErr := os.Stat(diskPath); statErr == nil {
				bk, berr := os.CreateTemp(filepath.Dir(diskPath), ".pgstack-backup-*")
				if berr != nil {
					log.Error().Err(berr).Str("dir", filepath.Dir(diskPath)).
						Msg("storage: open backup file")
					writeJSONError(w, http.StatusInternalServerError, "failed to stage backup")
					return
				}
				backupPath = bk.Name()
				_ = bk.Close()
				// Move existing diskPath aside; the CreateTemp file is
				// replaced atomically by the rename target.
				if err := os.Rename(diskPath, backupPath); err != nil {
					_ = os.Remove(backupPath)
					backupPath = ""
					log.Error().Err(err).Str("src", diskPath).Str("dst", backupPath).
						Msg("storage: backup existing file")
					writeJSONError(w, http.StatusInternalServerError, "failed to stage backup")
					return
				}
			}
			// Cleanup contract: backupPath != "" means a backup is in
			// flight that the happy path must consume. Failure paths set
			// it back to "" after explicit restore/cleanup.
			defer func() {
				if backupPath != "" {
					_ = os.Remove(backupPath)
				}
			}()

			if err := os.Rename(tmpPath, diskPath); err != nil {
				// Rename failed BEFORE diskPath was replaced. If we
				// backed up the previous file, restore it; otherwise
				// there was no file to begin with. tx rollback (defer)
				// undoes the DB upsert so metadata stays consistent.
				if backupPath != "" {
					if rerr := os.Rename(backupPath, diskPath); rerr != nil {
						log.Error().Err(rerr).Str("backup", backupPath).Str("final", diskPath).
							Msg("storage: restore backup after rename failure also failed — file lost")
					}
					backupPath = "" // restore consumed it
				}
				log.Error().Err(err).Str("tmp", tmpPath).Str("final", diskPath).
					Msg("storage: promote staged upload — rolling back tx")
				writeJSONError(w, http.StatusInternalServerError, "failed to finalise upload")
				return
			}
			tmpPath = "" // rename consumed the temp file; suppress defer cleanup.

			if err := tx.Commit(r.Context()); err != nil {
				// Rename succeeded, commit failed. DB will rollback (defer)
				// to whatever it was before — the previous metadata for an
				// overwrite, or nothing for an INSERT. Restore the on-disk
				// state to match: for an overwrite, swap the backup back
				// over the new file; for an INSERT (no backup), remove
				// the new file so a retry sees a clean slate.
				if backupPath != "" {
					if rerr := os.Rename(backupPath, diskPath); rerr != nil {
						log.Error().Err(rerr).Str("backup", backupPath).Str("final", diskPath).
							Msg("storage: restore backup after commit failure also failed — file lost")
					}
					backupPath = ""
				} else {
					_ = os.Remove(diskPath)
				}
				log.Error().Err(err).Str("final", diskPath).
					Msg("storage: tx commit after successful rename — restored previous file (or removed orphan)")
				writeJSONError(w, http.StatusInternalServerError, "failed to finalise upload")
				return
			}
			committed = true
		} else {
			// Database backend: bytea column carries the bytes; the
			// upsert itself is atomic, no FS to coordinate with.
			var (
				inserted bool
				prevSize *int64
				prevMime *string
				scanErr  error
			)
			if claims.Role == "service_role" {
				scanErr = d.Pool.QueryRow(r.Context(), upsertObjectDBServiceRole,
					bucketID, objName, fileSize, mimeType, fileData, ownerID,
				).Scan(&objectID, &inserted, &prevSize, &prevMime)
			} else {
				scanErr = d.Pool.QueryRow(r.Context(), upsertObjectDBOwnerLocked,
					bucketID, objName, fileSize, mimeType, fileData, ownerID,
				).Scan(&objectID, &inserted, &prevSize, &prevMime)
			}
			if errors.Is(scanErr, pgx.ErrNoRows) {
				writeJSONError(w, http.StatusForbidden, "cannot overwrite another user's object")
				return
			}
			if scanErr != nil {
				log.Error().Err(scanErr).Msg("storage: upload object")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}
			_, _, _ = inserted, prevSize, prevMime
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(uploadResponse{
			ID:  objectID,
			Key: bucketID + "/" + objName,
		})
	}
}

// DownloadObject handles GET /storage/v1/object/{bucket}/*.
func DownloadObject(d *StorageDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := storageResolveClaims(d, w, r)
		if !ok {
			return
		}

		bucketID := chi.URLParam(r, "bucket")
		objName := objectPath(r)
		if objName == "" {
			writeJSONError(w, http.StatusBadRequest, "object path is required")
			return
		}

		bucket := getBucket(d, w, r, bucketID)
		if bucket == nil {
			return
		}

		// Audit F1 (round 19): for the disk backend, take a SHARED
		// advisory lock so a concurrent upload (which holds an EXCLUSIVE
		// lock) cannot tear the (DB metadata, on-disk bytes) pair
		// underneath us. Multiple parallel reads of the same key DO NOT
		// block each other — pg_advisory_xact_lock_shared is reader/
		// reader compatible — so throughput is unaffected outside the
		// rare overwrite window. The DB backend has nothing to serialise
		// (data lives in the row) and skips the tx to avoid the round-
		// trip overhead on every download.
		var (
			mimeType, ownerStr string
			size               int64
			data               []byte
			err                error
		)
		if d.StorageBackend == "disk" {
			tx, txErr := d.Pool.Begin(r.Context())
			if txErr != nil {
				log.Error().Err(txErr).Msg("storage: begin download tx")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}
			defer func() { _ = tx.Rollback(r.Context()) }()
			if _, lerr := tx.Exec(r.Context(),
				`SELECT pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))`,
				bucketID, objName,
			); lerr != nil {
				log.Error().Err(lerr).Msg("storage: acquire shared lock for download")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}
			err = tx.QueryRow(r.Context(),
				`SELECT mime_type, size, COALESCE(owner::text, ''), data
				 FROM pgstack.storage_objects
				 WHERE bucket_id = $1 AND name = $2`,
				bucketID, objName,
			).Scan(&mimeType, &size, &ownerStr, &data)
		} else {
			err = d.Pool.QueryRow(r.Context(),
				`SELECT mime_type, size, COALESCE(owner::text, ''), data
				 FROM pgstack.storage_objects
				 WHERE bucket_id = $1 AND name = $2`,
				bucketID, objName,
			).Scan(&mimeType, &size, &ownerStr, &data)
		}
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeJSONError(w, http.StatusNotFound, "object not found")
			} else {
				log.Error().Err(err).Str("bucket", bucketID).Str("object", objName).Msg("storage: download query")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
			}
			return
		}

		// Auth check
		if !bucket.Public {
			// Private bucket: only owner or service_role can download
			if claims.Role == "anon" {
				writeJSONError(w, http.StatusForbidden, "access denied to private bucket")
				return
			}
			if claims.Role != "service_role" && claims.Sub != ownerStr {
				writeJSONError(w, http.StatusForbidden, "access denied: not the object owner")
				return
			}
		}

		// If disk backend, read from filesystem. The shared advisory lock
		// above is still held by the surrounding tx, so the file at
		// diskPath cannot be replaced by a concurrent upload while we
		// read it. The tx defers rollback until the response is fully
		// written, releasing the lock when the handler returns.
		if d.StorageBackend == "disk" && data == nil {
			diskPath, perr := safeStoragePath(d.StorageDir, bucketID, objName)
			if perr != nil {
				writeJSONError(w, http.StatusBadRequest, perr.Error())
				return
			}
			diskData, err := os.ReadFile(diskPath)
			if err != nil {
				if os.IsNotExist(err) {
					writeJSONError(w, http.StatusNotFound, "file not found on disk")
				} else {
					log.Error().Err(err).Str("path", diskPath).Msg("storage: disk read")
					writeJSONError(w, http.StatusInternalServerError, "failed to read file from disk")
				}
				return
			}
			data = diskData
		}

		// Determine filename for Content-Disposition
		parts := strings.Split(objName, "/")
		filename := parts[len(parts)-1]

		w.Header().Set("Content-Type", mimeType)
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
		safeName := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(filename)
		w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, safeName))
		if bucket.Public {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		} else {
			w.Header().Set("Cache-Control", "private, no-store")
		}
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write(data); err != nil {
			log.Error().Err(err).Str("bucket", bucketID).Str("object", objName).Msg("storage: write response body")
		}
	}
}

// DeleteObject handles DELETE /storage/v1/object/{bucket}/*.
func DeleteObject(d *StorageDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := storageResolveClaims(d, w, r)
		if !ok {
			return
		}

		bucketID := chi.URLParam(r, "bucket")
		objName := objectPath(r)
		if objName == "" {
			writeJSONError(w, http.StatusBadRequest, "object path is required")
			return
		}

		bucket := getBucket(d, w, r, bucketID)
		if bucket == nil {
			return
		}

		// Check access: anon cannot delete; authenticated can delete own objects;
		// service_role can delete any.
		if claims.Role == "anon" {
			writeJSONError(w, http.StatusForbidden, "delete requires authentication")
			return
		}

		// Audit F1 (round 19): for the disk backend wrap DB delete + file
		// remove in a tx with the EXCLUSIVE per-key lock so a concurrent
		// upload to the same key cannot land its rename between our
		// DELETE and our os.Remove (which would either remove the just-
		// written file or leave an orphan with a stale row). On commit
		// failure the file removal is skipped — the row stays, but the
		// orphan file is rare and the next list/sweep picks it up.
		var (
			tag string
			tx  pgx.Tx
		)
		if d.StorageBackend == "disk" {
			var txErr error
			tx, txErr = d.Pool.Begin(r.Context())
			if txErr != nil {
				log.Error().Err(txErr).Msg("storage: begin delete tx")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}
			defer func() {
				if tx != nil {
					_ = tx.Rollback(r.Context())
				}
			}()
			if _, lerr := tx.Exec(r.Context(),
				`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
				bucketID, objName,
			); lerr != nil {
				log.Error().Err(lerr).Msg("storage: acquire lock for delete")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}
		}

		runDeleteExec := func(sql string, args ...any) (string, error) {
			if d.StorageBackend == "disk" {
				result, err := tx.Exec(r.Context(), sql, args...)
				if err != nil {
					return "", err
				}
				return fmt.Sprintf("%d", result.RowsAffected()), nil
			}
			result, err := d.Pool.Exec(r.Context(), sql, args...)
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("%d", result.RowsAffected()), nil
		}

		var execErr error
		if claims.Role == "service_role" {
			tag, execErr = runDeleteExec(
				`DELETE FROM pgstack.storage_objects WHERE bucket_id = $1 AND name = $2`,
				bucketID, objName,
			)
		} else {
			tag, execErr = runDeleteExec(
				`DELETE FROM pgstack.storage_objects
				 WHERE bucket_id = $1 AND name = $2 AND owner = $3`,
				bucketID, objName, claims.Sub,
			)
		}
		if execErr != nil {
			log.Error().Err(execErr).Msg("storage: delete object")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		if tag == "0" {
			writeJSONError(w, http.StatusNotFound, "object not found or access denied")
			return
		}

		// If disk backend: commit DB first, then remove the file. On
		// commit failure the file stays — better than DB row gone +
		// file gone when we can't be sure DB rollback worked.
		if d.StorageBackend == "disk" {
			if err := tx.Commit(r.Context()); err != nil {
				log.Error().Err(err).Msg("storage: commit delete")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}
			tx = nil // suppress rollback in defer
			if diskPath, perr := safeStoragePath(d.StorageDir, bucketID, objName); perr == nil {
				_ = os.Remove(diskPath) // best-effort; DB row already gone
			}
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "object deleted"})
	}
}

// ListObjects handles GET /storage/v1/object/list/{bucket}.
// Supports ?prefix= for filtering by path prefix.
func ListObjects(d *StorageDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := storageResolveClaims(d, w, r)
		if !ok {
			return
		}

		bucketID := chi.URLParam(r, "bucket")

		bucket := getBucket(d, w, r, bucketID)
		if bucket == nil {
			return
		}

		// Private bucket: only authenticated or service_role can list
		if !bucket.Public && claims.Role == "anon" {
			writeJSONError(w, http.StatusForbidden, "access denied to private bucket")
			return
		}

		prefix := r.URL.Query().Get("prefix")

		var query string
		var args []any
		if prefix != "" {
			query = `SELECT id::text, name, size, mime_type, created_at
					 FROM pgstack.storage_objects
					 WHERE bucket_id = $1 AND name LIKE $2 || '%'
					 ORDER BY name`
			args = []any{bucketID, prefix}
		} else {
			query = `SELECT id::text, name, size, mime_type, created_at
					 FROM pgstack.storage_objects
					 WHERE bucket_id = $1
					 ORDER BY name`
			args = []any{bucketID}
		}

		// For private buckets, non-service_role users only see their own objects
		if !bucket.Public && claims.Role != "service_role" {
			if prefix != "" {
				query = `SELECT id::text, name, size, mime_type, created_at
						 FROM pgstack.storage_objects
						 WHERE bucket_id = $1 AND name LIKE $2 || '%' AND owner = $3
						 ORDER BY name`
				args = []any{bucketID, prefix, claims.Sub}
			} else {
				query = `SELECT id::text, name, size, mime_type, created_at
						 FROM pgstack.storage_objects
						 WHERE bucket_id = $1 AND owner = $2
						 ORDER BY name`
				args = []any{bucketID, claims.Sub}
			}
		}

		pgRows, err := d.Pool.Query(r.Context(), query, args...)
		if err != nil {
			log.Error().Err(err).Msg("storage: list objects")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}
		defer pgRows.Close()

		objects := make([]objectListItem, 0)
		for pgRows.Next() {
			var item objectListItem
			var createdAt time.Time
			var mimeType *string
			if err := pgRows.Scan(&item.ID, &item.Name, &item.Size, &mimeType, &createdAt); err != nil {
				log.Error().Err(err).Msg("storage: scan object row")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}
			if mimeType != nil {
				item.MimeType = *mimeType
			}
			item.CreatedAt = createdAt.Format(time.RFC3339)
			objects = append(objects, item)
		}
		if err := pgRows.Err(); err != nil {
			log.Error().Err(err).Msg("storage: list objects iteration")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(objects)
	}
}

// pgErrCode extracts the PostgreSQL SQLSTATE code from a pgx error.
func pgErrCode(err error) string {
	if err == nil {
		return ""
	}
	type pgError interface {
		SQLState() string
	}
	if e, ok := err.(pgError); ok {
		return e.SQLState()
	}
	return ""
}

// SweepDiskOrphans removes leftover .pgstack-upload-* and .pgstack-backup-*
// files older than minAge in storageDir/<bucket>/... . These are produced
// by an upload that crashed between os.CreateTemp and either successful
// Rename or the deferred cleanup, OR between backup-rename and the
// post-commit backup delete. In both cases the file has no DB row pointing
// at it, so removing it is safe.
//
// Audit F1 (round 19): closes the orphan accumulation that would otherwise
// follow a process kill during an upload. Intentionally conservative:
// minAge avoids racing in-flight uploads on the same shard. Run once at
// boot, optionally on a periodic ticker. Best-effort — errors are logged
// and the sweep moves on.
func SweepDiskOrphans(storageDir string, minAge time.Duration) {
	if storageDir == "" {
		return
	}
	cutoff := time.Now().Add(-minAge)
	removed := 0
	filepath.WalkDir(storageDir, func(path string, dirent os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil // skip unreadable subtrees
		}
		if dirent.IsDir() {
			return nil
		}
		name := dirent.Name()
		if !strings.HasPrefix(name, ".pgstack-upload-") && !strings.HasPrefix(name, ".pgstack-backup-") {
			return nil
		}
		info, err := dirent.Info()
		if err != nil {
			return nil
		}
		if info.ModTime().After(cutoff) {
			return nil // young file — might be a live upload
		}
		if err := os.Remove(path); err != nil {
			log.Warn().Err(err).Str("path", path).Msg("storage: orphan sweep — remove failed")
			return nil
		}
		removed++
		return nil
	})
	if removed > 0 {
		log.Info().Int("removed", removed).Str("dir", storageDir).
			Msg("storage: orphan sweep cleaned up stale staging/backup files")
	}
}

