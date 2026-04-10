#!/bin/bash
# End-to-end smoke test against live confession.website infra.
# Run post-deploy. Uses only curl + jq — no test framework required.
#
# Exercises:
#   - POST /api/compose (text-only) → slug + url
#   - GET  /api/slug/{slug}         (probe → 200 pending)
#   - POST /api/slug/{slug}/listen  (burn → text + reply_code)
#   - GET  /api/slug/{slug}         (probe → 404 burned)
#   - POST /api/slug/{slug}/compose (rally with reply_code → 201)
#   - POST /api/slug/{slug}/listen  (second-turn burn)
#   - POST /api/slug/{slug}/compose with stale code → 404 (replay reject)
#   - Audio round-trip: compose with audio_b64 → listen returns same bytes
#   - Slug collision: explicit slug taken twice → 409
#   - POST /api/slug/{slug}/subscribe → 201
#   - CORS: confession.website / ephemeral.website allowed, evil.example.com rejected
#   - Static frontend: /, /style.css, /sw.js all 200

set -euo pipefail

API="${API:-https://confession.website}"
SLUG_PREFIX="smoke-$(date +%s)-$$"

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }
step()  { blue "==> $*"; }
fail()  { red "FAIL: $*"; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require curl
require jq

# 1 KiB of random bytes — backend only checks MIME allowlist + base64
# decode + size ceiling, not that the bytes are real Opus.
SAMPLE_RAW=$(mktemp -t confession-smoke.XXXXXX)
trap 'rm -f "$SAMPLE_RAW"' EXIT
head -c 1024 /dev/urandom > "$SAMPLE_RAW"
SAMPLE_B64=$(base64 < "$SAMPLE_RAW" | tr -d '\n')
OPUS_MIME="audio/ogg; codecs=opus"

# ──────────────────────────────────────────────────────────────
step "1. POST /api/compose (text-only, server-generated slug)"
resp=$(curl -sS -X POST "$API/api/compose" \
  -H 'Content-Type: application/json' \
  -d '{"text":"smoke test message"}')
slug_a=$(echo "$resp" | jq -r '.slug')
url_a=$(echo "$resp" | jq -r '.url')
[[ -n "$slug_a" && "$slug_a" != "null" ]] || fail "no slug in response: $resp"
[[ "$url_a" == "https://confession.website/$slug_a" ]] || fail "unexpected url: $url_a"
green "    slug=$slug_a"

step "2. GET /api/slug/$slug_a (probe → pending)"
http_code=$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/slug/$slug_a")
[[ "$http_code" == "200" ]] || fail "probe expected 200, got $http_code"
green "    pending"

step "3. POST /api/slug/$slug_a/listen (text-only burn → terminal)"
resp=$(curl -sS -X POST "$API/api/slug/$slug_a/listen")
text_back=$(echo "$resp" | jq -r '.text // empty')
reply_code=$(echo "$resp" | jq -r '.reply_code // empty')
terminated=$(echo "$resp" | jq -r '.terminated')
[[ "$text_back" == "smoke test message" ]] || fail "expected text round-trip, got '$text_back'"
[[ "$terminated" == "true" ]] || fail "text-only consume should terminate, got terminated=$terminated"
[[ -z "$reply_code" ]] || fail "text-only burn should not mint reply_code, got '$reply_code'"
green "    text='$text_back' terminated=true reply_code=null"

step "4. GET /api/slug/$slug_a (probe → 404 after terminal burn)"
http_code=$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/slug/$slug_a")
[[ "$http_code" == "404" ]] || fail "probe after burn expected 404, got $http_code"
green "    channel closed"

# ──────────────────────────────────────────────────────────────
# Re-do the rally flow with an audio first turn so the channel is
# NOT terminal and we can test rally-compose.
step "5. POST /api/compose (audio first turn for rally test)"
resp=$(curl -sS -X POST "$API/api/compose" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg b "$SAMPLE_B64" --arg m "$OPUS_MIME" \
        '{audio_b64:$b, audio_mime:$m, text:"first turn"}')")
slug_b=$(echo "$resp" | jq -r '.slug')
[[ -n "$slug_b" && "$slug_b" != "null" ]] || fail "no slug in audio compose: $resp"
green "    slug=$slug_b"

step "6. POST /api/slug/$slug_b/listen (audio + text round trip)"
resp=$(curl -sS -X POST "$API/api/slug/$slug_b/listen")
text_back=$(echo "$resp" | jq -r '.text // empty')
audio_back=$(echo "$resp" | jq -r '.audio_b64 // empty')
mime_back=$(echo "$resp" | jq -r '.audio_mime // empty')
reply_code=$(echo "$resp" | jq -r '.reply_code // empty')
terminated=$(echo "$resp" | jq -r '.terminated')
[[ "$text_back" == "first turn" ]] || fail "text didn't survive: '$text_back'"
[[ -n "$audio_back" ]] || fail "audio_b64 missing on listen"
[[ "$audio_back" == "$SAMPLE_B64" ]] || fail "audio bytes did not round-trip"
[[ "$mime_back" == "$OPUS_MIME" ]] || fail "audio_mime mismatch: '$mime_back'"
[[ -n "$reply_code" ]] || fail "no reply_code"
[[ "$terminated" == "false" ]] || fail "audio consume should not terminate"
green "    audio bytes round-tripped (1024 bytes), reply_code=$reply_code"

step "7. POST /api/slug/$slug_b/compose (rally with valid reply_code)"
http_code=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST "$API/api/slug/$slug_b/compose" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg c "$reply_code" '{reply_code:$c, text:"rally turn"}')")
[[ "$http_code" == "201" ]] || fail "rally expected 201, got $http_code"
green "    rallied"

step "8. POST /api/slug/$slug_b/listen (second turn)"
resp=$(curl -sS -X POST "$API/api/slug/$slug_b/listen")
text_back=$(echo "$resp" | jq -r '.text // empty')
[[ "$text_back" == "rally turn" ]] || fail "rally text did not appear: '$text_back'"
green "    rally turn delivered"

step "9. POST /api/slug/$slug_b/compose with stale reply_code → 404"
http_code=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST "$API/api/slug/$slug_b/compose" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg c "$reply_code" '{reply_code:$c, text:"replay attempt"}')")
[[ "$http_code" == "404" ]] || fail "stale reply_code expected 404, got $http_code"
green "    replay correctly rejected"

# ──────────────────────────────────────────────────────────────
step "10. Slug collision: same explicit slug twice → 409"
slug_c="$SLUG_PREFIX-c"
http_code=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST "$API/api/compose" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg s "$slug_c" '{slug:$s, text:"first claim"}')")
[[ "$http_code" == "201" ]] || fail "first explicit-slug compose expected 201, got $http_code"

http_code=$(curl -sS -o /tmp/collision-body -w '%{http_code}' \
  -X POST "$API/api/compose" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg s "$slug_c" '{slug:$s, text:"second claim"}')")
[[ "$http_code" == "409" ]] || fail "collision expected 409, got $http_code ($(cat /tmp/collision-body))"
rm -f /tmp/collision-body
green "    collision rejected"

# Burn the collision slug so we don't leave it pending forever
curl -sS -o /dev/null -X POST "$API/api/slug/$slug_c/listen"

# ──────────────────────────────────────────────────────────────
step "11. Subscribe to a fresh slug → 201"
resp=$(curl -sS -X POST "$API/api/compose" \
  -H 'Content-Type: application/json' \
  -d '{"text":"subscribe target"}')
slug_d=$(echo "$resp" | jq -r '.slug')
http_code=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST "$API/api/slug/$slug_d/subscribe" \
  -H 'Content-Type: application/json' \
  -d '{"endpoint":"https://example.invalid/push/abc","p256dh":"BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM","auth":"tBHItJI5svbpez7KI4CCXg"}')
[[ "$http_code" == "201" ]] || fail "subscribe expected 201, got $http_code"
green "    subscribed"

# Burn it
curl -sS -o /dev/null -X POST "$API/api/slug/$slug_d/listen"

# ──────────────────────────────────────────────────────────────
step "12a. CORS preflight from confession.website (allowed)"
hdrs=$(curl -sS -o /dev/null -D - \
  -X OPTIONS "$API/api/compose" \
  -H 'Origin: https://confession.website' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: Content-Type')
echo "$hdrs" | grep -qi "access-control-allow-origin: https://confession.website" \
  || fail "expected CORS allow for confession.website, got: $(echo "$hdrs" | grep -i access-control || echo 'no CORS headers')"
green "    confession.website allowed"

step "12b. CORS preflight from ephemeral.website (allowed)"
hdrs=$(curl -sS -o /dev/null -D - \
  -X OPTIONS "$API/api/compose" \
  -H 'Origin: https://ephemeral.website' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: Content-Type')
echo "$hdrs" | grep -qi "access-control-allow-origin: https://ephemeral.website" \
  || fail "expected CORS allow for ephemeral.website"
green "    ephemeral.website allowed"

step "12c. CORS preflight from evil.example.com (rejected)"
hdrs=$(curl -sS -o /dev/null -D - \
  -X OPTIONS "$API/api/compose" \
  -H 'Origin: https://evil.example.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: Content-Type')
echo "$hdrs" | grep -qi "access-control-allow-origin: https://evil.example.com" \
  && fail "evil.example.com unexpectedly allowed"
green "    evil.example.com rejected"

# ──────────────────────────────────────────────────────────────
step "13. Static frontend served from site Lambda"
http_code=$(curl -sS -o /tmp/index-body -w '%{http_code}' "$API/")
[[ "$http_code" == "200" ]] || fail "GET / expected 200, got $http_code"
grep -q '<title>' /tmp/index-body || fail "/ did not return HTML with <title>"
rm -f /tmp/index-body

http_code=$(curl -sS -o /dev/null -w '%{http_code}' "$API/style.css")
[[ "$http_code" == "200" ]] || fail "GET /style.css expected 200, got $http_code"

http_code=$(curl -sS -o /dev/null -w '%{http_code}' "$API/sw.js")
[[ "$http_code" == "200" ]] || fail "GET /sw.js expected 200, got $http_code"
green "    /, /style.css, /sw.js all 200"

# ──────────────────────────────────────────────────────────────
green ""
green "all smoke checks passed ✓"
