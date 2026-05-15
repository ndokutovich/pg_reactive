package routes

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// DocsRedirect permanently redirects /docs → /docs/ so relative asset paths
// resolve correctly.
func DocsRedirect(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/docs/", http.StatusMovedPermanently)
}

// DocsSite returns an http.Handler that serves the Docusaurus build output
// from dir, falling back to index.html for unmatched paths. Path traversal
// is blocked by safeStaticPath() — see static.go.
func DocsSite(dir string) http.Handler {
	absDir, _ := filepath.Abs(dir)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/docs/")
		fullPath := safeStaticPath(absDir, path)
		if fullPath == "" {
			http.NotFound(w, r)
			return
		}

		if _, err := os.Stat(fullPath); err != nil {
			// Docusaurus generates per-page HTML files. Try appending index.html
			// for directory-style routes (e.g. /docs/rest/batch → rest/batch/index.html).
			dirIndex := filepath.Join(fullPath, "index.html")
			if _, err2 := os.Stat(dirIndex); err2 == nil {
				http.ServeFile(w, r, dirIndex)
				return
			}
			indexPath := filepath.Join(absDir, "index.html")
			if _, err3 := os.Stat(indexPath); err3 != nil {
				http.NotFound(w, r)
				return
			}
			http.ServeFile(w, r, indexPath)
			return
		}

		http.ServeFile(w, r, fullPath)
	})
}
