package main

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
)

// jsonHandler returns a handler that responds with a JSON body large enough
// to trigger gzip (chi's Compress middleware has a minimum size threshold).
func jsonHandler() http.HandlerFunc {
	// 1KB of JSON — well above chi's default min-size (varies by version, ~20-100 bytes).
	body := `{"data":"` + string(make([]byte, 1024)) + `"}`
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(body))
	}
}

func TestGzip_CompressedWhenEnabled(t *testing.T) {
	r := chi.NewRouter()
	r.Use(chiMiddleware.Compress(5))
	r.Get("/test", jsonHandler())

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
	if ce := rec.Header().Get("Content-Encoding"); ce != "gzip" {
		t.Fatalf("Content-Encoding: got %q, want gzip", ce)
	}

	// Verify body is valid gzip.
	gz, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	defer gz.Close()
	body, err := io.ReadAll(gz)
	if err != nil {
		t.Fatalf("reading gzip body: %v", err)
	}
	if len(body) == 0 {
		t.Fatal("decompressed body is empty")
	}
}

func TestGzip_NotCompressedWithoutAcceptEncoding(t *testing.T) {
	r := chi.NewRouter()
	r.Use(chiMiddleware.Compress(5))
	r.Get("/test", jsonHandler())

	req := httptest.NewRequest("GET", "/test", nil)
	// No Accept-Encoding header.
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
	if ce := rec.Header().Get("Content-Encoding"); ce == "gzip" {
		t.Fatal("expected no gzip when Accept-Encoding is absent")
	}
}

func TestGzip_DisabledWhenLevelZero(t *testing.T) {
	r := chi.NewRouter()
	// Level 0 = disabled — the middleware shouldn't even be added.
	// We simulate the main.go logic: only add middleware when GzipLevel > 0.
	gzipLevel := 0
	if gzipLevel > 0 {
		r.Use(chiMiddleware.Compress(gzipLevel))
	}
	r.Get("/test", jsonHandler())

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if ce := rec.Header().Get("Content-Encoding"); ce == "gzip" {
		t.Fatal("expected no gzip when level is 0")
	}
}
