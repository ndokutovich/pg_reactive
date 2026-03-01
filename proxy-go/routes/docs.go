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
// from dir, falling back to index.html for unmatched paths.
func DocsSite(dir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/docs/")
		if path == "" {
			path = "index.html"
		}

		fullPath := filepath.Join(dir, filepath.FromSlash(path))

		if _, err := os.Stat(fullPath); err != nil {
			// Docusaurus generates per-page HTML files. Try appending index.html
			// for directory-style routes (e.g. /docs/rest/batch → rest/batch/index.html).
			dirIndex := filepath.Join(fullPath, "index.html")
			if _, err2 := os.Stat(dirIndex); err2 == nil {
				http.ServeFile(w, r, dirIndex)
				return
			}
			// Final fallback: root index.html.
			indexPath := filepath.Join(dir, "index.html")
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
