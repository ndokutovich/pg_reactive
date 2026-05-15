package routes

import (
	"path/filepath"
	"strings"
)

// safeStaticPath resolves urlPath against absDir and guarantees the result
// stays inside absDir. Returns "" when urlPath escapes the root, is absolute,
// or otherwise looks hostile. absDir must already be absolute (filepath.Abs).
//
// Shared by PublicSPA, StudioSPA, and DocsSite. The previous implementations
// either used a plain strings.HasPrefix (which lets /tmp/store-other slip past
// /tmp/store) or relied on http.ServeFile's own traversal guard alone.
func safeStaticPath(absDir, urlPath string) string {
	if absDir == "" {
		return ""
	}
	if urlPath == "" {
		urlPath = "index.html"
	}
	// Reject any leading separator (POSIX `/`, Windows `\`) — Go's filepath.IsAbs
	// is GOOS-dependent and lets `/etc/passwd` through on Windows.
	if strings.HasPrefix(urlPath, "/") || strings.HasPrefix(urlPath, `\`) ||
		filepath.IsAbs(urlPath) || strings.ContainsRune(urlPath, 0) {
		return ""
	}
	// Drive-letter sneak: `C:foo` is not IsAbs on POSIX but is hostile on Windows.
	if len(urlPath) >= 2 && urlPath[1] == ':' {
		return ""
	}
	cleaned := filepath.Clean(filepath.Join(absDir, filepath.FromSlash(urlPath)))
	rel, err := filepath.Rel(absDir, cleaned)
	if err != nil {
		return ""
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return ""
	}
	return cleaned
}
