package routes

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestSafeStaticPath_AllowsRelative(t *testing.T) {
	root, _ := filepath.Abs(t.TempDir())
	got := safeStaticPath(root, "assets/app.js")
	want := filepath.Join(root, "assets", "app.js")
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestSafeStaticPath_EmptyResolvesToIndex(t *testing.T) {
	root, _ := filepath.Abs(t.TempDir())
	got := safeStaticPath(root, "")
	want := filepath.Join(root, "index.html")
	if got != want {
		t.Fatalf("empty path must resolve to index.html, got %q want %q", got, want)
	}
}

func TestSafeStaticPath_RejectsTraversal(t *testing.T) {
	root, _ := filepath.Abs(t.TempDir())
	for _, name := range []string{
		"../etc/passwd",
		"../../etc/passwd",
		"a/../../secret",
		"./../escape",
	} {
		t.Run(name, func(t *testing.T) {
			if got := safeStaticPath(root, name); got != "" {
				t.Fatalf("expected empty for %q, got %q", name, got)
			}
		})
	}
}

func TestSafeStaticPath_RejectsAbsolute(t *testing.T) {
	root, _ := filepath.Abs(t.TempDir())
	for _, name := range []string{
		"/etc/passwd",
		`C:\Windows\cmd.exe`,
		`\\unc\share\file`,
	} {
		t.Run(name, func(t *testing.T) {
			if got := safeStaticPath(root, name); got != "" {
				t.Fatalf("expected empty for %q, got %q", name, got)
			}
		})
	}
}

// Regression for the old PublicSPA HasPrefix bug — absDir `/tmp/store` must NOT
// accept paths that resolve under `/tmp/store-other`.
func TestSafeStaticPath_RejectsLookalikeSiblingDir(t *testing.T) {
	// Simulate the two directories.
	base := t.TempDir()
	store := filepath.Join(base, "store")
	storeOther := filepath.Join(base, "store-other")
	_ = os.MkdirAll(store, 0o755)
	_ = os.MkdirAll(storeOther, 0o755)

	// Request from inside `store` that tries to escape into `store-other`.
	got := safeStaticPath(store, "../store-other/file.txt")
	if got != "" {
		t.Fatalf("must not let store escape to store-other, got %q", got)
	}
}

// Integration: StudioSPA and DocsSite must 404 on traversal attempts rather
// than serve files outside their dir.
func TestStudioSPA_RejectsTraversal(t *testing.T) {
	tmp := t.TempDir()
	_ = os.WriteFile(filepath.Join(tmp, "index.html"), []byte("ok"), 0o644)

	r := httptest.NewRequest(http.MethodGet, "/studio/../../etc/passwd", nil)
	rec := httptest.NewRecorder()
	StudioSPA(tmp).ServeHTTP(rec, r)

	// We accept either 404 (traversal rejected) or 200 + index.html (SPA fallback
	// after rejection). What we must NOT serve is the traversal target.
	if rec.Code == http.StatusOK && string(rec.Body.Bytes()) != "ok" {
		t.Fatalf("served unexpected content: %q", rec.Body.String())
	}
}

func TestDocsSite_RejectsTraversal(t *testing.T) {
	tmp := t.TempDir()
	_ = os.WriteFile(filepath.Join(tmp, "index.html"), []byte("docs"), 0o644)

	r := httptest.NewRequest(http.MethodGet, "/docs/../../etc/passwd", nil)
	rec := httptest.NewRecorder()
	DocsSite(tmp).ServeHTTP(rec, r)

	if rec.Code == http.StatusOK && string(rec.Body.Bytes()) != "docs" {
		t.Fatalf("served unexpected content: %q", rec.Body.String())
	}
}
