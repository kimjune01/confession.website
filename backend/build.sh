#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Copy frontend files into the site handler for go:embed.
# Wipe first so removed-source files don't linger in the embedded FS.
rm -rf cmd/site/static
mkdir -p cmd/site/static/fonts
cp ../frontend/*.html cmd/site/static/
cp ../frontend/*.css cmd/site/static/
cp ../frontend/*.js cmd/site/static/
cp ../frontend/fonts/*.woff2 cmd/site/static/fonts/
cp "../frontend/fonts/Charter license.txt" cmd/site/static/fonts/
cp "../frontend/fonts/IBM Plex OFL.txt" cmd/site/static/fonts/

for cmd in compose probe peek listen rally_compose subscribe site; do
    echo "Building $cmd..."
    GOOS=linux GOARCH=arm64 go build -o "dist/$cmd/bootstrap" "./cmd/$cmd"
    (cd "dist/$cmd" && zip -q "../$cmd.zip" bootstrap)
done

echo "Done. Artifacts in backend/dist/"
