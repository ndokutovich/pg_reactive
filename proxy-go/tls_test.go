package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPToHTTPSRedirect(t *testing.T) {
	handler := httpToHTTPSRedirect()

	tests := []struct {
		name     string
		host     string
		path     string
		wantLoc  string
	}{
		{
			name:    "root path",
			host:    "example.com",
			path:    "/",
			wantLoc: "https://example.com/",
		},
		{
			name:    "path with query",
			host:    "example.com",
			path:    "/studio/?tab=sql",
			wantLoc: "https://example.com/studio/?tab=sql",
		},
		{
			name:    "API endpoint",
			host:    "app.example.com",
			path:    "/rest/v1/todos?id=eq.1",
			wantLoc: "https://app.example.com/rest/v1/todos?id=eq.1",
		},
		{
			name:    "host with port",
			host:    "example.com:8080",
			path:    "/health",
			wantLoc: "https://example.com:8080/health",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "http://"+tt.host+tt.path, nil)
			req.Host = tt.host
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusMovedPermanently {
				t.Errorf("status: got %d, want 301", rec.Code)
			}
			loc := rec.Header().Get("Location")
			if loc != tt.wantLoc {
				t.Errorf("Location: got %q, want %q", loc, tt.wantLoc)
			}
		})
	}
}

func TestStartPlainHTTP_ServerConfig(t *testing.T) {
	// Verify that startPlainHTTP builds a server with correct config
	// (without actually binding a port — we inspect the returned server).
	cfg := Config{
		ListenAddr:   "127.0.0.1:0", // port 0 = OS picks free port
		ReadTimeout:  10 * 1e9,       // 10s in nanoseconds (time.Duration)
		WriteTimeout: 20 * 1e9,
		IdleTimeout:  30 * 1e9,
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	})

	servers := startPlainHTTP(cfg, handler)
	if len(servers) != 1 {
		t.Fatalf("expected 1 server, got %d", len(servers))
	}

	srv := servers[0]
	if srv.Addr != "127.0.0.1:0" {
		t.Errorf("Addr: got %q, want 127.0.0.1:0", srv.Addr)
	}
	if srv.ReadTimeout != cfg.ReadTimeout {
		t.Errorf("ReadTimeout: got %v, want %v", srv.ReadTimeout, cfg.ReadTimeout)
	}
	if srv.WriteTimeout != cfg.WriteTimeout {
		t.Errorf("WriteTimeout: got %v, want %v", srv.WriteTimeout, cfg.WriteTimeout)
	}
	if srv.IdleTimeout != cfg.IdleTimeout {
		t.Errorf("IdleTimeout: got %v, want %v", srv.IdleTimeout, cfg.IdleTimeout)
	}

	// Clean up — shutdown the server we started.
	srv.Close()
}
