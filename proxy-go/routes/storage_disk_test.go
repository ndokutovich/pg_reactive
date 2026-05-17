package routes

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These tests exercise the filesystem layer of the disk storage backend in
// isolation.  The HTTP handlers themselves require a live pgxpool connection,
// so we test the OS operations (path construction, write, read, remove) that
// the handlers delegate to directly, using the same filepath.Join expression
// the production code uses.

// diskPath replicates the path expression used by UploadObject, DownloadObject,
// and DeleteObject when StorageBackend == "disk".
func diskPath(storageDir, bucketID, objName string) string {
	return filepath.Join(storageDir, bucketID, objName)
}

// ── path construction ─────────────────────────────────────────────────────────

func TestDiskPath_SimpleObject(t *testing.T) {
	got := diskPath("/storage", "avatars", "user-1.png")
	want := filepath.Join("/storage", "avatars", "user-1.png")
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestDiskPath_NestedObjectName(t *testing.T) {
	got := diskPath("/data", "docs", "2024/reports/q1.pdf")
	want := filepath.Join("/data", "docs", "2024/reports/q1.pdf")
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestDiskPath_UsesStorageDir(t *testing.T) {
	dir := t.TempDir()
	p := diskPath(dir, "mybucket", "file.txt")
	if !filepath.IsAbs(p) {
		t.Errorf("expected absolute path, got %q", p)
	}
	// Must start with the storageDir prefix.
	rel, err := filepath.Rel(dir, p)
	if err != nil {
		t.Fatalf("Rel: %v", err)
	}
	want := filepath.Join("mybucket", "file.txt")
	if rel != want {
		t.Errorf("relative part: got %q, want %q", rel, want)
	}
}

// ── upload: write file to disk ────────────────────────────────────────────────

func TestDiskUpload_WritesFileAtCorrectPath(t *testing.T) {
	dir := t.TempDir()
	bucketID := "images"
	objName := "photo.jpg"
	content := []byte("fake-jpeg-data")

	p := diskPath(dir, bucketID, objName)

	// Replicate what UploadObject does on the disk branch:
	//   os.MkdirAll(filepath.Dir(diskPath), 0o755)
	//   os.WriteFile(diskPath, fileData, 0o644)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(p, content, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// Verify the file exists at the expected location.
	got, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != string(content) {
		t.Errorf("content mismatch: got %q, want %q", got, content)
	}
}

func TestDiskUpload_CreatesIntermediateDirectories(t *testing.T) {
	dir := t.TempDir()
	p := diskPath(dir, "bucket", "a/b/c/deep.txt")

	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(p, []byte("data"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if _, err := os.Stat(p); err != nil {
		t.Errorf("expected file to exist after nested MkdirAll + WriteFile: %v", err)
	}
}

func TestDiskUpload_OverwritesExistingFile(t *testing.T) {
	dir := t.TempDir()
	p := diskPath(dir, "bkt", "item.bin")

	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	_ = os.WriteFile(p, []byte("original"), 0o644)

	newContent := []byte("updated-content")
	if err := os.WriteFile(p, newContent, 0o644); err != nil {
		t.Fatalf("WriteFile overwrite: %v", err)
	}

	got, _ := os.ReadFile(p)
	if string(got) != string(newContent) {
		t.Errorf("expected overwritten content %q, got %q", newContent, got)
	}
}

// ── download: read file from disk ─────────────────────────────────────────────

func TestDiskDownload_ReadsFileFromFilesystem(t *testing.T) {
	dir := t.TempDir()
	bucketID := "videos"
	objName := "clip.mp4"
	expected := []byte("fake-video-bytes")

	p := diskPath(dir, bucketID, objName)
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	_ = os.WriteFile(p, expected, 0o644)

	// Replicate the disk branch of DownloadObject:
	//   if d.StorageBackend == "disk" && data == nil { os.ReadFile(diskPath) }
	// We simulate the "data is NULL" condition — the handler would call os.ReadFile.
	diskData, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(diskData) != string(expected) {
		t.Errorf("got %q, want %q", diskData, expected)
	}
}

func TestDiskDownload_ReturnsNotExistErrorForMissingFile(t *testing.T) {
	dir := t.TempDir()
	p := diskPath(dir, "bucket", "missing.txt")

	_, err := os.ReadFile(p)
	if err == nil {
		t.Fatal("expected error reading a non-existent file")
	}
	if !os.IsNotExist(err) {
		t.Errorf("expected os.IsNotExist, got: %v", err)
	}
}

// ── delete: remove file from disk ────────────────────────────────────────────

func TestDiskDelete_RemovesFileFromFilesystem(t *testing.T) {
	dir := t.TempDir()
	p := diskPath(dir, "trash", "old-file.log")

	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	_ = os.WriteFile(p, []byte("to be removed"), 0o644)

	// Replicate the disk branch of DeleteObject:
	//   os.Remove(diskPath)  // best-effort
	if err := os.Remove(p); err != nil {
		t.Fatalf("os.Remove: %v", err)
	}

	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Error("expected file to be gone after os.Remove")
	}
}

func TestDiskDelete_BestEffortOnMissingFile(t *testing.T) {
	dir := t.TempDir()
	p := diskPath(dir, "bucket", "never-existed.txt")

	// The production code uses _ = os.Remove(diskPath), ignoring errors.
	// Verify os.Remove on a missing path does not panic and returns an error
	// (which the handler discards).
	err := os.Remove(p)
	if err == nil {
		t.Fatal("expected an error when removing a non-existent file")
	}
	if !os.IsNotExist(err) {
		t.Errorf("expected os.IsNotExist, got: %v", err)
	}
}

// ── StorageDeps struct fields ─────────────────────────────────────────────────

func TestStorageDeps_DiskFields(t *testing.T) {
	dir := t.TempDir()
	d := StorageDeps{
		StorageBackend: "disk",
		StorageDir:     dir,
		MaxFileSize:    10 * 1024 * 1024,
	}
	if d.StorageBackend != "disk" {
		t.Errorf("StorageBackend: got %q, want %q", d.StorageBackend, "disk")
	}
	if d.StorageDir != dir {
		t.Errorf("StorageDir: got %q, want %q", d.StorageDir, dir)
	}
}

func TestStorageDeps_DefaultBackendIsDatabase(t *testing.T) {
	// When StorageBackend is not set it defaults to the zero value "".
	// The handler treats anything that is not "disk" as the database backend.
	d := StorageDeps{}
	if d.StorageBackend == "disk" {
		t.Error("zero-value StorageDeps should not default to disk backend")
	}
}

// ── stage-then-rename pattern (round 15 + 16) ─────────────────────────
//
// These tests pin the FS-level assumptions the disk upload flow now
// relies on:
//
//   1. CreateTemp + Write + Close + Rename atomically promotes a
//      staged file into its final location. The DB claim happens
//      between Close and Rename; the on-disk state never holds a
//      partially-written file under the final key.
//   2. A failed Rename leaves the existing destination file intact.
//      This is what makes the round-16 "restore previous metadata"
//      compensation correct: the on-disk bytes never changed, so
//      reverting the DB metadata is sufficient.
//   3. The deferred-cleanup pattern removes the temp file when an
//      early return aborts before Rename succeeds, so the storage
//      directory never accumulates orphan .pgstack-upload-* files.

func TestStaging_RenamePromotesAtomically(t *testing.T) {
	dir := t.TempDir()
	final := filepath.Join(dir, "image.jpg")

	tmp, err := os.CreateTemp(dir, ".pgstack-upload-*")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write([]byte("staged content")); err != nil {
		t.Fatalf("write tmp: %v", err)
	}
	if err := tmp.Close(); err != nil {
		t.Fatalf("close tmp: %v", err)
	}

	if err := os.Rename(tmpPath, final); err != nil {
		t.Fatalf("rename: %v", err)
	}

	// Final exists, has the staged bytes; tmp no longer exists.
	got, err := os.ReadFile(final)
	if err != nil {
		t.Fatalf("read final: %v", err)
	}
	if string(got) != "staged content" {
		t.Fatalf("final content: got %q, want %q", got, "staged content")
	}
	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Fatalf("expected tmp gone after rename, got err=%v", err)
	}
}

func TestStaging_RenameOverwriteAtomically(t *testing.T) {
	// The round-16 compensation argument: when rename SUCCEEDS over an
	// existing destination, the old content is replaced; when it FAILS,
	// the old content remains. We pin the success branch here and the
	// failure branch in the next test.
	dir := t.TempDir()
	final := filepath.Join(dir, "image.jpg")
	if err := os.WriteFile(final, []byte("old content"), 0o644); err != nil {
		t.Fatalf("seed final: %v", err)
	}

	tmp, err := os.CreateTemp(dir, ".pgstack-upload-*")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	tmpPath := tmp.Name()
	_, _ = tmp.Write([]byte("new content"))
	_ = tmp.Close()

	if err := os.Rename(tmpPath, final); err != nil {
		t.Fatalf("rename: %v", err)
	}

	got, _ := os.ReadFile(final)
	if string(got) != "new content" {
		t.Fatalf("final content: got %q, want %q", got, "new content")
	}
}

func TestStaging_FailedRenamePreservesDestination(t *testing.T) {
	// Force a rename failure by trying to rename into a path whose
	// parent does not exist. On every platform os.Rename returns an
	// error in that case; the existing destination (if any, here we
	// seed one) must be untouched.
	dir := t.TempDir()
	finalDir := filepath.Join(dir, "real-final-dir")
	if err := os.MkdirAll(finalDir, 0o755); err != nil {
		t.Fatalf("mkdir final dir: %v", err)
	}
	final := filepath.Join(finalDir, "image.jpg")
	if err := os.WriteFile(final, []byte("preserved"), 0o644); err != nil {
		t.Fatalf("seed final: %v", err)
	}

	// Stage in a sibling directory and then try to rename to a path
	// whose parent does not exist — guaranteed failure.
	tmp, err := os.CreateTemp(dir, ".pgstack-upload-*")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	tmpPath := tmp.Name()
	_, _ = tmp.Write([]byte("new bytes"))
	_ = tmp.Close()

	badTarget := filepath.Join(dir, "no-such-dir", "image.jpg")
	if err := os.Rename(tmpPath, badTarget); err == nil {
		t.Fatal("expected rename into non-existent dir to fail")
	}

	// The pre-existing final file is untouched, so the round-16
	// "restore metadata to match this file" compensation is correct.
	got, err := os.ReadFile(final)
	if err != nil {
		t.Fatalf("read final after failed rename: %v", err)
	}
	if string(got) != "preserved" {
		t.Fatalf("destination changed after failed rename: got %q", got)
	}

	// Production cleanup: the defer os.Remove(tmpPath) in UploadObject
	// runs after the failure and removes the staged file.
	_ = os.Remove(tmpPath)
	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Fatalf("expected staged tmp removed by cleanup, got err=%v", err)
	}
}

func TestStaging_DeferredCleanupRemovesOrphan(t *testing.T) {
	// Simulate the early-return path: we stage but never rename, so the
	// deferred cleanup must remove the staged file before the handler
	// returns. Pins that the staging directory does not accumulate
	// orphan .pgstack-upload-* files when an upload aborts (e.g. DB
	// claim failed, owner-gate refused, etc.).
	dir := t.TempDir()

	tmp, err := os.CreateTemp(dir, ".pgstack-upload-*")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	tmpPath := tmp.Name()
	_, _ = tmp.Write([]byte("never promoted"))
	_ = tmp.Close()

	// Production: the defer os.Remove(tmpPath) inside UploadObject's
	// disk branch removes the staged file when the handler aborts
	// before clearing tmpPath via successful rename. We replicate that
	// here.
	if err := os.Remove(tmpPath); err != nil {
		t.Fatalf("deferred cleanup: %v", err)
	}

	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".pgstack-upload-") {
			t.Fatalf("staged orphan remained after cleanup: %s", e.Name())
		}
	}
}
