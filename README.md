# confession.website

One listen, then gone.

Record a voice message, get a link, hand it to one person. They hear it
once — the audio is deleted on play. If they want to reply, a 5-minute
window opens. Audio keeps the rally going; text ends the channel.

No accounts, no feed, no inbox. The URL is the whole credential.

## Layout

```
frontend/        vanilla HTML/CSS/JS + service worker (no build step)
  fonts/         Charter italic + IBM Plex Sans (Latin-1 subset, self-hosted)
  content.js     shared buildContent helper
backend/         Go Lambda handlers
  cmd/           one main.go per handler
  internal/      shared store, audio validation, push, wordlist
infra/           Pulumi Go (S3 + DDB + Lambda + API Gateway + Route53 + ACM)
scripts/         smoke-test.sh (end-to-end against live infra)
.env             VAPID keys (gitignored, see "Secrets" below)
SPEC.md          wire format, data model, atomicity contracts
DESIGN.md        principles and stakes
```

## Backend

Go Lambdas on `provided.al2023` / arm64. Single DynamoDB table (`META` +
`SUB#` items under `PK = slug#<id>`), single S3 audio bucket, DDB TTL
handles cleanup.

Build all handlers:

```bash
cd backend && ./build.sh
```

Handlers:

| Route                              | Method | Handler          | Purpose |
| ---------------------------------- | ------ | ---------------- | ------- |
| `/api/compose`                     | POST   | `compose`        | Create a confession (audio + optional text) |
| `/api/slug/{slug}`                 | GET    | `probe`          | Check if slug is pending / replyable |
| `/api/slug/{slug}/peek`            | GET    | `peek`           | Read audio without burning (2-phase listen) |
| `/api/slug/{slug}/listen`          | POST   | `listen`         | Burn + mint reply code |
| `/api/slug/{slug}/compose`         | POST   | `rally_compose`  | Reply with audio (rally) or text (terminate) |
| `/api/slug/{slug}/subscribe`       | POST   | `subscribe`      | Web Push subscription |
| `$default`                         | ANY    | `site`           | Static frontend (go:embed) |

Env vars: `META_TABLE`, `AUDIO_BUCKET`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

### Slug generation

1000 adjectives × 1000 nouns = 1,000,000 combinations. 5-retry
collision budget. Comfortable up to ~200K monthly users at 1-week TTL.

## Frontend

Plain HTML/CSS/JS in `frontend/`. No bundler, no framework. The site
Lambda embeds these files via `go:embed` and serves them directly.

Key architecture decisions:
- **State machine** (`state.js`) drives all transitions
- **2-phase listen**: `peek` (read-only) during 3s countdown, `burn` after playback starts
- **Optimistic UI**: seal transitions to FIRST_SENT immediately, link populates on API response
- **CSS spacing scale**: 6 custom properties (`--sp-1` through `--sp-6`)
- **Dark academia aesthetic**: Charter italic headline (debossed), IBM Plex Sans body, near-black midnight ground with dingbat checker + noise grain
- **Web Push** via VAPID (empty payload — generic notification, no confession content)

Serve locally:

```bash
python3 -m http.server 12345 --directory frontend/
```

## Deploy

```bash
cd backend && ./build.sh
cd ../infra && pulumi up
```

Pulumi reads VAPID keys from `../.env` via `godotenv`. The `.env`
file is gitignored.

## Secrets

VAPID keys live in `.env` at the project root:

```
VAPID_PUBLIC_KEY=<base64url>
VAPID_PRIVATE_KEY=<base64url>
VAPID_SUBJECT=mailto:<contact email>
```

Generate a fresh pair:

```bash
cd backend && go run -exec echo internal/wordlist.go  # won't work, use:
# Install webpush-go, then:
go run github.com/SherClockHolmes/webpush-go/cmd/webpush-keygen
```

Or any VAPID key generator. The public key is injected into `index.html`
at serve time by the site Lambda (`{{VAPID_PUBLIC_KEY}}` placeholder).

Keys are disposable — regenerating invalidates existing push
subscriptions, but subscribers are transient (1-week slug TTL).

## Smoke tests

```bash
bash scripts/smoke-test.sh
```

Exercises: compose, probe (`has_audio`, `replyable`), peek (read-only
round-trip), listen (burn + rally), rally compose, stale replay
rejection, slug collision, subscribe, CORS, static frontend, VAPID key
injection.

## Tone

Dark academia. The invitation is heavy. No jokes in copy, no playful
fonts, no upbeat colors. If a UI choice feels wrong for confessing
something real, it is wrong.

## License

AGPL-3.0. See [LICENSE](./LICENSE).
