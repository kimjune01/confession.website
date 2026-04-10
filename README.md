# confession.website

Tell it once. Then let it go.

A one-listen voice confession. The writer records, the recipient hears it
once, and then it's gone. Optional text reply via a code-gated "rally"
window, optional Web Push subscribe. No accounts, no feed, no inbox.

## Layout

```
frontend/   vanilla HTML/CSS/JS + service worker (no build step)
backend/    Go Lambda handlers (compose, probe, listen, rally_compose, subscribe)
infra/      Pulumi Go (not yet created)
SPEC.md     wire format, data model, atomicity contracts — the build target
DESIGN.md   principles and stakes behind the spec
IMPLEMENTATION.md  milestones and internal structure
```

## Backend

Go Lambdas on `provided.al2023` / arm64. Single DynamoDB table (`META` + `SUB#`
items under `PK = slug#<id>`), single S3 audio bucket, DDB TTL handles cleanup.

Build all five handlers to `backend/dist/<name>/bootstrap` + `.zip`:

```bash
cd backend && ./build.sh
```

Handlers:

| Route                              | Method | Binary          |
| ---------------------------------- | ------ | --------------- |
| `/api/compose`                     | POST   | `compose`       |
| `/api/slug/{slug}`                 | GET    | `probe`         |
| `/api/slug/{slug}/listen`          | POST   | `listen`        |
| `/api/slug/{slug}/compose`         | POST   | `rally_compose` |
| `/api/slug/{slug}/subscribe`       | POST   | `subscribe`     |

Env vars: `META_TABLE`, `AUDIO_BUCKET`. Local DDB/S3 endpoints via
`DDB_ENDPOINT` / `S3_ENDPOINT` for smoke tests.

## Frontend

Plain HTML/CSS/JS in `frontend/`. No bundler. Serve locally with:

```bash
python3 -m http.server 12345 --directory frontend/
```

API calls hit `https://confession.website/api/...` — for local testing
against prod, the API Gateway CORS allowlist must include
`http://localhost:12345`.

## Deploy

Pulumi Go, same pattern as `../ephemeral.website/infra/`:
S3 + DynamoDB + Lambda per handler + API Gateway HTTP API + Route53 +
ACM. `infra/` is not yet wired up; the full `main.go` will live there.

## Tone

The invitation is heavy. Users come here to say the thing they haven't told
anyone. No jokes in copy, no playful fonts, no upbeat colors. If a UI choice
feels wrong for confessing something real, it is wrong.

## License

AGPL-3.0. See [LICENSE](./LICENSE).
