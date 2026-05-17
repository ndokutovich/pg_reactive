package routes

import (
	"context"
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

	// Compensation when the post-claim disk rename fails for an UPDATE
	// upsert. The previous file on disk is untouched (rename failed before
	// consuming the existing dest), so restoring the previous metadata
	// makes the (row, file) pair consistent again.
	restoreObjectMetadata = `
		UPDATE pgstack.storage_objects
		SET size = $1, mime_type = $2, updated_at = now()
		WHERE id = $3`
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

		var (
			objectID string
			inserted bool
			prevSize *int64
			prevMime *string
			scanErr  error
		)
		if claims.Role == "service_role" {
			if d.StorageBackend == "disk" {
				scanErr = d.Pool.QueryRow(r.Context(), upsertObjectDiskServiceRole,
					bucketID, objName, fileSize, mimeType, ownerID,
				).Scan(&objectID, &inserted, &prevSize, &prevMime)
			} else {
				scanErr = d.Pool.QueryRow(r.Context(), upsertObjectDBServiceRole,
					bucketID, objName, fileSize, mimeType, fileData, ownerID,
				).Scan(&objectID, &inserted, &prevSize, &prevMime)
			}
		} else {
			if d.StorageBackend == "disk" {
				scanErr = d.Pool.QueryRow(r.Context(), upsertObjectDiskOwnerLocked,
					bucketID, objName, fileSize, mimeType, ownerID,
				).Scan(&objectID, &inserted, &prevSize, &prevMime)
			} else {
				scanErr = d.Pool.QueryRow(r.Context(), upsertObjectDBOwnerLocked,
					bucketID, objName, fileSize, mimeType, fileData, ownerID,
				).Scan(&objectID, &inserted, &prevSize, &prevMime)
			}
		}
		if errors.Is(scanErr, pgx.ErrNoRows) {
			// The UPDATE branch's WHERE filtered the row out — another user
			// owns this bucket/name. Same 403 as the explicit pre-check used
			// to return.
			writeJSONError(w, http.StatusForbidden, "cannot overwrite another user's object")
			return
		}
		if scanErr != nil {
			log.Error().Err(scanErr).Msg("storage: upload object")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		// DB claim succeeded — promote the staged file into its final
		// location atomically (POSIX rename). If rename fails we compensate:
		//   - inserted (no prior file or row): DELETE the freshly-inserted
		//     row so a retry can claim the key cleanly.
		//   - overwrite (prior file still intact at diskPath because the
		//     failed rename never replaced it): restore the previous
		//     size/mime_type so the row matches the file again. Skipping
		//     this would leave a row whose metadata describes the new
		//     payload while the file on disk still holds the old bytes.
		if d.StorageBackend == "disk" {
			if err := os.Rename(tmpPath, diskPath); err != nil {
				log.Error().Err(err).Str("tmp", tmpPath).Str("final", diskPath).
					Bool("inserted", inserted).
					Msg("storage: promote staged upload — compensating DB row")
				compensateDiskRenameFailure(r.Context(), d.Pool, objectID, inserted, prevSize, prevMime)
				writeJSONError(w, http.StatusInternalServerError, "failed to finalise upload")
				return
			}
			tmpPath = "" // rename consumed the temp file; suppress defer cleanup.
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

		// Query the object metadata (and data if database backend)
		var mimeType, ownerStr string
		var size int64
		var data []byte
		err := d.Pool.QueryRow(r.Context(),
			`SELECT mime_type, size, COALESCE(owner::text, ''), data
			 FROM pgstack.storage_objects
			 WHERE bucket_id = $1 AND name = $2`,
			bucketID, objName,
		).Scan(&mimeType, &size, &ownerStr, &data)
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

		// If disk backend, read from filesystem
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

		var tag string
		if claims.Role == "service_role" {
			// Service role can delete any object
			result, err := d.Pool.Exec(r.Context(),
				`DELETE FROM pgstack.storage_objects WHERE bucket_id = $1 AND name = $2`,
				bucketID, objName)
			if err != nil {
				log.Error().Err(err).Msg("storage: delete object")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}
			tag = fmt.Sprintf("%d", result.RowsAffected())
		} else {
			// Authenticated user: only delete own objects
			result, err := d.Pool.Exec(r.Context(),
				`DELETE FROM pgstack.storage_objects
				 WHERE bucket_id = $1 AND name = $2 AND owner = $3`,
				bucketID, objName, claims.Sub)
			if err != nil {
				log.Error().Err(err).Msg("storage: delete object")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}
			tag = fmt.Sprintf("%d", result.RowsAffected())
		}

		if tag == "0" {
			writeJSONError(w, http.StatusNotFound, "object not found or access denied")
			return
		}

		// If disk backend, also remove the file from disk
		if d.StorageBackend == "disk" {
			if diskPath, perr := safeStoragePath(d.StorageDir, bucketID, objName); perr == nil {
				_ = os.Remove(diskPath) // best-effort; DB record is already gone
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

// compensateDiskRenameFailure undoes the DB side of a disk upload whose
// post-claim os.Rename failed. The semantics are different for INSERT vs
// UPDATE — see the call site for the rationale. Errors are logged but
// not surfaced; the caller has already decided to return 500.
func compensateDiskRenameFailure(
	ctx context.Context,
	pool *pgxpool.Pool,
	objectID string,
	inserted bool,
	prevSize *int64,
	prevMime *string,
) {
	if inserted {
		if _, err := pool.Exec(ctx,
			`DELETE FROM pgstack.storage_objects WHERE id = $1`,
			objectID); err != nil {
			log.Error().Err(err).Str("id", objectID).
				Msg("storage: compensation delete failed — row may be orphaned")
		}
		return
	}
	// UPDATE path: the prior row existed and the prior file at diskPath
	// was untouched by the failed rename. Restore the previous size and
	// mime so the metadata matches the bytes still on disk.
	if prevSize == nil || prevMime == nil {
		// Defensive: should never happen — an UPDATE upsert by definition
		// has a prior row. If we get here, the metadata is inconsistent
		// and we have no way to repair it; leave a loud log line.
		log.Error().Str("id", objectID).
			Msg("storage: compensation update skipped — previous metadata unavailable; row metadata may not match disk file")
		return
	}
	if _, err := pool.Exec(ctx, restoreObjectMetadata,
		*prevSize, *prevMime, objectID); err != nil {
		log.Error().Err(err).Str("id", objectID).
			Msg("storage: compensation update failed — row metadata may not match disk file")
	}
}
