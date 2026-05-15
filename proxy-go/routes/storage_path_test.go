package routes

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSafeStoragePath_AllowsCleanRelative(t *testing.T) {
	root := t.TempDir()
	got, err := safeStoragePath(root, "avatars", "user/42/pic.png")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := filepath.Join(root, "avatars", "user", "42", "pic.png")
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestSafeStoragePath_RejectsTraversal(t *testing.T) {
	root := t.TempDir()
	cases := []string{
		"../etc/passwd",
		"../../etc/passwd",
		"a/../../../etc/passwd",
		"./../escape",
		"a/b/../../../escape",
	}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := safeStoragePath(root, "bucket", name); err == nil {
				t.Fatalf("expected error for %q, got nil", name)
			}
		})
	}
}

func TestSafeStoragePath_RejectsAbsolute(t *testing.T) {
	root := t.TempDir()
	cases := []string{
		"/etc/passwd",
		`\Windows\System32\cmd.exe`,
		`C:\Windows\System32\cmd.exe`,
		`\\server\share\file`,
		"D:/secret",
	}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := safeStoragePath(root, "bucket", name); err == nil {
				t.Fatalf("expected error for %q, got nil", name)
			}
		})
	}
}

func TestSafeStoragePath_RejectsInvalidBucket(t *testing.T) {
	root := t.TempDir()
	cases := []string{"..", "a/b", `a\b`, "../foo"}
	for _, b := range cases {
		t.Run(b, func(t *testing.T) {
			if _, err := safeStoragePath(root, b, "ok.txt"); err == nil {
				t.Fatalf("expected error for bucket %q, got nil", b)
			}
		})
	}
}

func TestSafeStoragePath_RejectsEmptyInputs(t *testing.T) {
	if _, err := safeStoragePath("", "b", "o"); err == nil {
		t.Fatal("empty root must be rejected")
	}
	if _, err := safeStoragePath("/tmp", "", "o"); err == nil {
		t.Fatal("empty bucket must be rejected")
	}
	if _, err := safeStoragePath("/tmp", "b", ""); err == nil {
		t.Fatal("empty object must be rejected")
	}
}

func TestSafeStoragePath_RejectsNUL(t *testing.T) {
	root := t.TempDir()
	if _, err := safeStoragePath(root, "b", "ok\x00.txt"); err == nil {
		t.Fatal("NUL in object path must be rejected")
	}
}

func TestSafeStoragePath_ResolvedPathIsUnderRoot(t *testing.T) {
	root := t.TempDir()
	got, err := safeStoragePath(root, "b", "nested/dir/file.bin")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	absRoot, _ := filepath.Abs(root)
	// HasPrefix is OK here because filepath.Clean already collapsed any tricks.
	if !strings.HasPrefix(got, absRoot) {
		t.Fatalf("resolved %q escapes root %q (GOOS=%s)", got, absRoot, runtime.GOOS)
	}
}
