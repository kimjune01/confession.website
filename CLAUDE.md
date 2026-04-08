# confession.website

A layer on top of [ephemeral.website](https://ephemeral.website). Records a voice
confession and uses ephemeral's public v1 API to store and serve it.

## Local dev

`frontend/` is plain HTML/CSS/JS. Open `frontend/index.html` in a browser. All
API calls go to `https://ephemeral.website/api` which has CORS configured to
accept `https://confession.website` as an allowed origin.

For local testing, you'll need to run a local dev server (e.g.
`python3 -m http.server 12345 --directory frontend/`) and either (a) accept
that API calls will fail because localhost isn't in the ephemeral CORS
allowlist, or (b) temporarily add `http://localhost:12345` to ephemeral's CORS
config in `../ephemeral.website/infra/main.go` and redeploy.

## API integration

This site uses exactly two endpoints from ephemeral:

- `POST https://ephemeral.website/api/upload` — create a whisper
- `PUT <presigned S3 URL>` — upload the audio bytes

The recipient's playback happens on `https://ephemeral.website/<token>`, not on
confession.website. We hand off the link and let the core handle playback.

Full API contract: [ephemeral.website/api](https://ephemeral.website/api) or
`../ephemeral.website/docs/api.md`.

## What this site is NOT

- A platform. There are no accounts, no feed, no profiles.
- A messaging app. There is no inbox, no thread, no reply.
- A moderation surface. Content is deleted after one listen; we never see it.
- A product family. Each `.website` layer is its own disposable thing.

## Tone

The invitation is heavy. Users come to this site to say the thing they haven't
told anyone. Treat that seriously. No jokes in copy, no playful fonts, no
upbeat colors. If you're not sure whether a UI choice fits, ask: "would I want
this vibe when confessing something?"
