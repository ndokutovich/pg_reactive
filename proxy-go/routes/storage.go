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

		// Private bucket: only owner (authenticated) or service_role can upload
		if !bucket.Public && claims.Role == "anon" {
			writeJSONError(w, http.StatusForbidden, "upload to private bucket requires authentication")
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

		// IDOR check: prevent overwriting another user's object in private buckets
		if !bucket.Public && claims.Role != "service_role" {
			var existingOwner *string
			ownerErr := d.Pool.QueryRow(r.Context(),
				`SELECT owner::text FROM pgstack.storage_objects WHERE bucket_id = $1 AND name = $2`,
				bucketID, objName).Scan(&existingOwner)
			if ownerErr != nil && !errors.Is(ownerErr, pgx.ErrNoRows) {
				log.Error().Err(ownerErr).Msg("storage: IDOR owner check")
				writeJSONError(w, http.StatusInternalServerError, "internal database error")
				return
			}
			if ownerErr == nil && existingOwner != nil && *existingOwner != claims.Sub {
				writeJSONError(w, http.StatusForbidden, "cannot overwrite another user's object")
				return
			}
		}

		// Determine owner UUID (nil for anon/service_role without sub)
		var ownerID *string
		if claims.Sub != "" {
			ownerID = &claims.Sub
		}

		var objectID string

		if d.StorageBackend == "disk" {
			// Disk backend: write file to filesystem, store NULL for data column
			diskPath, perr := safeStoragePath(d.StorageDir, bucketID, objName)
			if perr != nil {
				writeJSONError(w, http.StatusBadRequest, perr.Error())
				return
			}
			if err := os.MkdirAll(filepath.Dir(diskPath), 0o755); err != nil {
				log.Error().Err(err).Str("path", diskPath).Msg("storage: mkdir for disk upload")
				writeJSONError(w, http.StatusInternalServerError, "failed to create storage directory")
				return
			}
			if err := os.WriteFile(diskPath, fileData, 0o644); err != nil {
				log.Error().Err(err).Str("path", diskPath).Msg("storage: disk write")
				writeJSONError(w, http.StatusInternalServerError, "failed to write file to disk")
				return
			}
			err = d.Pool.QueryRow(r.Context(),
				`INSERT INTO pgstack.storage_objects (bucket_id, name, size, mime_type, data, owner)
				 VALUES ($1, $2, $3, $4, NULL, $5)
				 ON CONFLICT (bucket_id, name) DO UPDATE
				   SET size = EXCLUDED.size,
				       mime_type = EXCLUDED.mime_type,
				       data = NULL,
				       owner = EXCLUDED.owner,
				       updated_at = now()
				 RETURNING id::text`,
				bucketID, objName, fileSize, mimeType, ownerID,
			).Scan(&objectID)
		} else {
			// Database backend: store file data in bytea column
			err = d.Pool.QueryRow(r.Context(),
				`INSERT INTO pgstack.storage_objects (bucket_id, name, size, mime_type, data, owner)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 ON CONFLICT (bucket_id, name) DO UPDATE
				   SET size = EXCLUDED.size,
				       mime_type = EXCLUDED.mime_type,
				       data = EXCLUDED.data,
				       owner = EXCLUDED.owner,
				       updated_at = now()
				 RETURNING id::text`,
				bucketID, objName, fileSize, mimeType, fileData, ownerID,
			).Scan(&objectID)
		}
		if err != nil {
			log.Error().Err(err).Msg("storage: upload object")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
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
