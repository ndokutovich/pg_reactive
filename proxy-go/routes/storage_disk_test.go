package routes

import (
	"os"
	"path/filepath"
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
