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

	// HTML stays no-cache so updates flow immediately. Static assets
	// (css, js, fonts) cache for a minute. The service worker is
	// special: browsers re-fetch sw.js on every page load if
	// Cache-Control allows, so keep it no-cache to ensure updates
	// take effect.
	cacheControl := "no-cache"
	if ext != ".html" && !strings.HasSuffix(filename, "/sw.js") {
		cacheControl = "public, max-age=60"
	}

	// Binary assets (fonts, images) must be base64-encoded so API
	// Gateway's JSON envelope doesn't mangle non-UTF8 bytes.
	body := string(data)
	isBase64 := false
	if ext == ".woff2" || ext == ".woff" || ext == ".ttf" || ext == ".otf" {
		body = base64.StdEncoding.EncodeToString(data)
		isBase64 = true
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
