// Local HTTP server for smoke-testing all five handlers on one port.
// Reads the same env vars as Lambda (META_TABLE, AUDIO_BUCKET, plus
// optional DDB_ENDPOINT / S3_ENDPOINT for DynamoDB Local / MinIO).
//
// Usage:
//
//	META_TABLE=confession-dev \
//	AUDIO_BUCKET=confession-dev-audio \
//	DDB_ENDPOINT=http://localhost:8000 \
//	S3_ENDPOINT=http://localhost:9000 \
//	AWS_ACCESS_KEY_ID=fake AWS_SECRET_ACCESS_KEY=fake AWS_REGION=us-east-1 \
//	go run ./cmd/local
package main

import (
	"context"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"confession-backend/internal/handlers/compose"
	"confession-backend/internal/handlers/listen"
	"confession-backend/internal/handlers/probe"
	rally_compose "confession-backend/internal/handlers/rally_compose"
	"confession-backend/internal/handlers/subscribe"

	"github.com/aws/aws-lambda-go/events"
)

type handlerFunc func(ctx context.Context, req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error)

var slugRoute = regexp.MustCompile(`^/api/slug/([^/]+)(/[^/]*)?$`)

// frontendFS is resolved once at startup. Search order:
//  1. FRONTEND_DIR env var (absolute path).
//  2. ../frontend relative to this source file's directory (works
//     for `go run ./cmd/local` from anywhere).
//  3. ./frontend relative to the process CWD.
var frontendFS http.Handler

func translate(w http.ResponseWriter, r *http.Request, h handlerFunc, pathParams map[string]string) {
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()

	headers := map[string]string{}
	for k, v := range r.Header {
		if len(v) > 0 {
			headers[strings.ToLower(k)] = v[0]
		}
	}

	req := events.APIGatewayV2HTTPRequest{
		Version:        "2.0",
		RouteKey:       r.Method + " " + r.URL.Path,
		RawPath:        r.URL.Path,
		RawQueryString: r.URL.RawQuery,
		Headers:        headers,
		Body:           string(body),
		PathParameters: pathParams,
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{
				Method: r.Method,
				Path:   r.URL.Path,
			},
		},
	}

	resp, err := h(r.Context(), req)
	if err != nil {
		log.Printf("handler error: %v", err)
		http.Error(w, "internal error", 500)
		return
	}
	for k, v := range resp.Headers {
		w.Header().Set(k, v)
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.WriteString(w, resp.Body)
}

func router(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	method := r.Method

	// POST /api/compose — first-turn compose
	if path == "/api/compose" && method == http.MethodPost {
		translate(w, r, compose.Handler, nil)
		return
	}

	// /api/slug/<slug>[/<action>]
	if m := slugRoute.FindStringSubmatch(path); m != nil {
		slug := m[1]
		action := ""
		if len(m) > 2 {
			action = strings.TrimPrefix(m[2], "/")
		}
		params := map[string]string{"slug": slug}
		switch {
		case action == "" && method == http.MethodGet:
			translate(w, r, probe.Handler, params)
			return
		case action == "listen" && method == http.MethodPost:
			translate(w, r, listen.Handler, params)
			return
		case action == "compose" && method == http.MethodPost:
			translate(w, r, rally_compose.Handler, params)
			return
		case action == "subscribe" && method == http.MethodPost:
			translate(w, r, subscribe.Handler, params)
			return
		}
	}

	// Static file serving. Paths that look like files (contain a
	// dot in the final segment — /app.js, /style.css, /sw.js) are
	// served directly. Everything else rewrites to /index.html so
	// the SPA can resolve the slug client-side.
	w.Header().Set("Cache-Control", "no-store")
	if path != "/" && !strings.Contains(filepath.Base(path), ".") {
		r = r.Clone(r.Context())
		r.URL.Path = "/"
	}
	frontendFS.ServeHTTP(w, r)
}

func resolveFrontendDir() string {
	if v := os.Getenv("FRONTEND_DIR"); v != "" {
		return v
	}
	// Resolve via the location of this source file. Works for
	// `go run ./cmd/local` from any CWD because Go's build system
	// preserves the source path.
	if _, file, _, ok := runtime.Caller(0); ok {
		// .../backend/cmd/local/main.go → .../frontend
		return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", "frontend"))
	}
	return filepath.Clean("./frontend")
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	addr := ":" + port

	frontendDir := resolveFrontendDir()
	if _, err := os.Stat(frontendDir); err != nil {
		log.Fatalf("frontend dir %q not found: %v", frontendDir, err)
	}
	frontendFS = http.FileServer(http.Dir(frontendDir))

	log.Printf("confession.website local backend listening on %s", addr)
	log.Printf("frontend served from %s", frontendDir)
	log.Printf("env META_TABLE=%q AUDIO_BUCKET=%q DDB_ENDPOINT=%q S3_ENDPOINT=%q",
		os.Getenv("META_TABLE"), os.Getenv("AUDIO_BUCKET"),
		os.Getenv("DDB_ENDPOINT"), os.Getenv("S3_ENDPOINT"))

	log.Fatal(http.ListenAndServe(addr, http.HandlerFunc(router)))
}
