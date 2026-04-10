#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Copy frontend files into the site handler for go:embed.
mkdir -p cmd/site/static
cp ../frontend/*.html cmd/site/static/
cp ../frontend/*.css cmd/site/static/
cp ../frontend/*.js cmd/site/static/

for cmd in compose probe listen rally_compose subscribe site; do
    echo "Building $cmd..."
    GOOS=linux GOARCH=arm64 go build -o "dist/$cmd/bootstrap" "./cmd/$cmd"
    (cd "dist/$cmd" && zip -q "../$cmd.zip" bootstrap)
done

echo "Done. Artifacts in backend/dist/"
