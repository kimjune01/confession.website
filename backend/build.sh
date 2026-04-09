#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

for cmd in compose probe listen rally_compose subscribe; do
    echo "Building $cmd..."
    GOOS=linux GOARCH=arm64 go build -o "dist/$cmd/bootstrap" "./cmd/$cmd"
    (cd "dist/$cmd" && zip -q "../$cmd.zip" bootstrap)
done

echo "Done. Artifacts in backend/dist/"
