// Package main is the static-frontend Lambda. It embeds frontend/ at
// build time and serves files by exact path. Unknown paths fall back
// to index.html for SPA-style slug routing (/<slug>).
//
// Pattern adapted from ephemeral.website/backend/cmd/site/main.go,
// but uses filesystem lookup instead of a hardcoded switch since
// confession's frontend has more files.
package main

import (
	"context"
	"embed"
	"encoding/base64"
	"html"
	"os"
	"path"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

//go:embed static
var static embed.FS

var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".js":    "application/javascript; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".svg":   "image/svg+xml",
	".woff2": "font/woff2",
	".woff":  "font/woff",
	".txt":   "text/plain; charset=utf-8",
}

func handler(_ context.Context, req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	reqPath := req.RawPath
	if reqPath == "" || reqPath == "/" {
		return serve("static/index.html")
	}

	// Try exact filesystem lookup; on miss, SPA fallback to index.html.
	trimmed := strings.TrimPrefix(reqPath, "/")
	filename := "static/" + trimmed
	if _, err := static.ReadFile(filename); err != nil {
		return serve("static/index.html")
	}
	return serve(filename)
}

func serve(filename string) (events.APIGatewayV2HTTPResponse, error) {
	data, err := static.ReadFile(filename)
	if err != nil {
		return events.APIGatewayV2HTTPResponse{StatusCode: 500}, nil
	}

	ext := path.Ext(filename)
	ct := contentTypes[ext]
	if ct == "" {
		ct = "text/plain; charset=utf-8"
	}

	// Cache tiers by content volatility:
	// - HTML/SW: no-cache (VAPID injection, always fresh)
	// - CSS/JS: 10 min (changes per deploy, not per request)
	// - Fonts: 1 year (immutable between deploys)
	cacheControl := "no-cache"
	if ext == ".woff2" || ext == ".woff" || ext == ".ttf" || ext == ".otf" {
		cacheControl = "public, max-age=31536000, immutable"
	} else if ext != ".html" && !strings.HasSuffix(filename, "/sw.js") {
		cacheControl = "public, max-age=600"
	}

	// Binary assets (fonts, images) must be base64-encoded so API
	// Gateway's JSON envelope doesn't mangle non-UTF8 bytes.
	body := string(data)
	isBase64 := false
	if ext == ".woff2" || ext == ".woff" || ext == ".ttf" || ext == ".otf" {
		body = base64.StdEncoding.EncodeToString(data)
		isBase64 = true
	}

	// Inject the VAPID public key into index.html at serve time. The
	// key is not a secret — the client uses it to construct the
	// subscription — but hardcoding it into the static file would
	// couple the deploy pipeline to the key. html.EscapeString is
	// belt-and-braces: real VAPID keys are base64url and can't break
	// out of the attribute, but the escape means a misconfigured
	// env var can't become an HTML-injection vector.
	if ext == ".html" {
		body = strings.ReplaceAll(body, "{{VAPID_PUBLIC_KEY}}", html.EscapeString(os.Getenv("VAPID_PUBLIC_KEY")))
	}

	return events.APIGatewayV2HTTPResponse{
		StatusCode: 200,
		Headers: map[string]string{
			"Content-Type":  ct,
			"Cache-Control": cacheControl,
		},
		Body:            body,
		IsBase64Encoded: isBase64,
	}, nil
}

func main() {
	lambda.Start(handler)
}
