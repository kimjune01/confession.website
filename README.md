# confession.website

Tell it once. Then let it go.

A layer on top of [ephemeral.website](https://ephemeral.website). Records a single
voice confession, uploads it to ephemeral's S3 via the public API, and returns a
one-listen link. The recipient hears it once, and then it's gone.

## Stack

Pure HTML/CSS/JS. No backend. No accounts. No database. The whole site is three
files in `frontend/` that call `https://ephemeral.website/api/upload` from the
browser via CORS.

This keeps confession.website a thin themed lens over a primitive it doesn't
own. If ephemeral.website breaks, confession.website breaks. If confession.website
goes away, ephemeral.website keeps working. The layer is disposable by design.

## Deploy

Not deployed yet. The domain `confession.website` is available for registration
(~$2). The static files in `frontend/` can be hosted anywhere — S3 + CloudFront,
Cloudflare Pages, Netlify, or the same Go Lambda + API Gateway pattern as
ephemeral.website if you want consistency.

## Philosophy

See [ephemeral.website/CLAUDE.md](../ephemeral.website/CLAUDE.md) for the core
primitive and constraints this is built on. confession.website adds no new
features — it only changes the invitation. Same one-listen audio, different
emotional register. The name is the pitch.
