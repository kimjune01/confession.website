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
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
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

	http.NotFound(w, r)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	addr := ":" + port
	log.Printf("confession.website local backend listening on %s", addr)
	log.Printf("env META_TABLE=%q AUDIO_BUCKET=%q DDB_ENDPOINT=%q S3_ENDPOINT=%q",
		os.Getenv("META_TABLE"), os.Getenv("AUDIO_BUCKET"),
		os.Getenv("DDB_ENDPOINT"), os.Getenv("S3_ENDPOINT"))

	// Keep json import live for future health-check endpoints.
	_ = json.Marshal
	log.Fatal(http.ListenAndServe(addr, http.HandlerFunc(router)))
}
