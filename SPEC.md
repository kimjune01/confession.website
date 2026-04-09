# confession.website — spec

Implementation target. Principles and stakes live in
[`DESIGN.md`](./DESIGN.md); this doc is how to build it.

## Data model

### Server — DynamoDB

One table. Composite key: `PK = slug#<id>`, `SK = META | NODE#<seq> |
SUB#<endpoint_hash>`. No GSIs. One S3 bucket for audio blobs.
DynamoDB TTL on `expires_at` handles all cleanup.

**META** — one per slug. Created on first-turn compose, destroyed
by DDB TTL ~48 h after `expires_at`.

```
PK         = slug#<id>
SK         = META
tail_seq   : int             — seq of the current tail NODE
tail_burned: bool            — current tail has been stubbed
terminal   : bool            — channel permanently closed (text-only consume)
created_at : ISO8601
expires_at : int (epoch)     — created_at + 7d; DDB TTL attribute
```

**NODE** — one per turn. Zero-padded seq for lexicographic sort order.
Never deleted individually; erased by DDB TTL alongside the rest of
the slug.

```
PK           = slug#<id>
SK           = NODE#<zero-padded seq, width 6>
seq          : int
audio_s3_key : string | absent      — e.g. audio/<slug_id>/<16-hex>.opus
text         : string | absent      — ≤ 280 chars
created_at   : ISO8601
burned       : bool                 — content has been stubbed
expires_at   : int (epoch)          — same as META.expires_at; DDB TTL attribute
```

Field hygiene on burn: `text` and `audio_s3_key` are `REMOVE`'d in
the burn transaction. The reveal Lambda holds `audio_s3_key` in
memory through the synchronous S3 `DeleteObject` that follows the
burn commit. Absence of the content fields is the invariant.

**SUB** — web push subscription. Plural per slug.

```
PK         = slug#<id>
SK         = SUB#<first8hex(sha256(endpoint))>
endpoint   : string
p256dh     : string
auth       : string
added_at   : ISO8601
expires_at : int (epoch)   — same as META.expires_at; DDB TTL attribute
```

`SK` is deterministic from `endpoint`, so duplicate subscribes are a
conditional put → at most one entry per endpoint. Plurality capped
at **N=4** per slug; subscribes past the cap evict the oldest by
`added_at`.

**Expiry via DDB TTL.** Every item (META, NODE, SUB) carries the
same `expires_at` value on creation — copied from META at rally
compose (via reply_token, see below) and at subscribe time (via
`GetItem` META). DynamoDB TTL is configured on `expires_at`; each
item is deleted independently within ~48 hours of its TTL. No cron,
no sweeper Lambda, no GSI on `expires_at`.

API handlers filter reads by `expires_at > :now` on every code path.
Items past TTL but not yet deleted look identical to absent items.

**Atomicity contracts.** Every mutating path includes
`expires_at > :now` on META. An expired slug fails every mutation.

- **First-turn compose** — one `TransactWriteItems`:
  - `Put META`, cond `attribute_not_exists(PK)`. Collision → retry
    with a fresh auto-generated slug (see
    [first-turn compose](#post-apicompose)), or return 409 if the
    slug was user-specified.
  - `Put NODE#000001` (no condition — first ever node in this slug).
- **Rally compose (token-gated)** — one `TransactWriteItems`:
  - `Put NODE#<token.seq+1>`, cond `attribute_not_exists(SK)`.
  - `Update META`, cond `tail_seq = :token_seq AND tail_burned = true
    AND terminal = false AND expires_at > :now`; set
    `tail_seq = :token_seq+1, tail_burned = false`. The `tail_seq`
    match is the replay guard.
- **Reveal — commit burn** — one `TransactWriteItems`:
  - `Update NODE#<seq>`, cond `burned = false`; set `burned = true`;
    `REMOVE text, audio_s3_key`. The Lambda holds `audio_s3_key`
    in memory for the synchronous S3 delete that follows this
    transaction.
  - `Update META`, cond `tail_seq = :seq AND tail_burned = false AND
    expires_at > :now`; set `tail_burned = true,
    terminal = :was_text_only`.

The reveal path reads META and NODE sequentially before the
transaction (to know `tail_seq` and `audio_s3_key`) and before the
S3 read. Two GetItems + one GetObject + one TransactWriteItems +
one DeleteObject. No lease, no nonce, no in-flight field — racing
reveals simply contend on the NODE burn condition, one wins, the
other returns 404. The loser discards any bytes it already read.

### Client — per-browser `localStorage`

Per-slug state. A browser can hold state for any number of slugs
concurrently — no one-alive invariant. Each slug's record is
independent.

```
slugs : {
  "<slug_id>": {
    role             : "creator" | "consumer",
    created_at       : ISO8601,
    reply_capability : {               — present iff last reveal was non-terminal
      token     : string,              — reply_token from reveal response
      reveal_at : int (epoch)          — client time; drives UI countdown
    } | null
  },
  ...
}
```

- A slug record is created on successful first-turn compose
  (`role = "creator"`) or successful reveal (`role = "consumer"`).
  Multiple slugs can coexist — the user is free to open new
  confessions while others are still alive.
- `reply_capability` is set on successful reveal (non-terminal)
  and cleared on successful rally-compose **or** on countdown
  expiry (`reveal_at + SUBMIT_DEADLINE < :now`). The enclosing
  `slugs` key already scopes the capability to the right slug.
- A slug record is pruned by the UI when `reveal_at +
  SUBMIT_DEADLINE < :now` (no live reply window), or when the
  user explicitly clears history. Stale records are harmless but
  take up space.
- Clearing `localStorage` abandons all slugs from this browser's
  perspective. The server has no way to reconnect.

### Slug canonicalization

`slug_id ∈ [a-z0-9-]{3,32}`. Lowercase ASCII letters, digits, and
hyphen. No leading or trailing hyphen. Router, DDB PK, reply-token
HMAC input, and S3 key prefix all use the same canonical string —
no case folding, percent-decoding, or Unicode normalization applied
anywhere downstream of request parse. Any request carrying a slug
outside this grammar is rejected at the edge (400) before reaching
handlers.

## HTTP API

All non-success responses that would otherwise leak state collapse to
`404`. Internal error distinctions exist for logic and logs (content-
free), never on the wire.

**Wire limits:**

- Request body ≤ **1 MB**.
- `audio_b64` decoded ≤ **512 KB**. Opus at 32 kbps × 2 min ≈ 480 KB,
  leaving a small margin for codec overhead.
- `audio_mime` must be `audio/ogg; codecs=opus` or
  `audio/webm; codecs=opus`. Anything else is 400.
- `text` ≤ 280 chars (UTF-8, post-NFC normalization at parse).
- `reply_token` base64url decodes to exactly 36 bytes
  (4 seq + 8 exp + 8 slug_exp + 16 hmac). Non-canonical base64url
  is rejected.

### `GET /api/slug/<id>`

Probe. Bare body — no metadata leakage (not even `has_audio` /
`has_text`).

```
200 { }    — META exists AND tail pending AND not terminal AND expires_at > :now
404 { }    — everything else (including META still present but TTL lag)
```

The `expires_at > :now` check is in code, not a condition
expression — a `GetItem` with a post-read filter. This closes the
≤48 h TTL lag window during which an expired META might still exist
in the table.

### `POST /api/slug/<id>/reveal`

Atomic burn. Returns content inline. Mints `reply_token`.

```
request  : (empty body)

response 200:
  {
    text       : string | null,
    audio_mime : string | null,      — e.g. "audio/ogg; codecs=opus"
    audio_b64  : string | null,
    terminated : bool,
    reply_token: string | null       — null iff terminated
  }

response 404: any other state (never-existed, burned-empty,
              terminated, expired, race lost)
```

**Sequence:**

1. **Read META** via `GetItem`. Verify `expires_at > :now`,
   `tail_burned = false`, `terminal = false`. On any failure: 404.
   Extract `tail_seq` and `expires_at`.
2. **Read NODE#<tail_seq>** via `GetItem`. Verify
   `burned = false`. Extract `audio_s3_key` and `text`. On failure:
   404.
3. **Read audio** from S3 if `audio_s3_key` present. On failure:
   return 404. (No state to clean up — no writes yet.)
4. **Commit burn** via `TransactWriteItems` as described above.
   On `ConditionalCheckFailed`: return 404. **Do not return content,
   do not delete S3** — someone else won the race, and the bytes
   in memory are not ours to hand out.
5. **Sync `DeleteObject` S3** using the in-memory `audio_s3_key`.
   On failure: log content-free, continue. S3 lifecycle catches
   orphans within 8 days.
6. **Mint `reply_token`** — see [Reply token format](#reply-token-format).
   `null` if the burn set `terminal = true`.
7. **Return body** containing content bytes (as base64) and token.

**At-most-once delivery, sharpened.** If the burn transaction in
step 4 commits but the response never reaches the client
(disconnect, crash, proxy hang), the message is burned unread *and*
no `reply_token` was delivered. The slug is immediately dead:
nothing to reveal (content stubbed), no token to compose (never
received). DDB TTL eventually erases the husk. This is the cost of
burn guarantees — the medium trades delivery certainty for burn
certainty. Aligned with "bravery deserves closure, not extraction"
in DESIGN.md.

### `POST /api/slug/<id>/compose`

Rally-compose. Token-gated. Distinct endpoint from first-turn compose.

```
request:
  {
    reply_token : string,
    audio_b64   : string | null,
    text        : string | null    — ≤ 280 chars
  }
  At least one of audio_b64 or text required.

response 201: { }
response 400: token invalid, token expired, no content, text too long
response 404: slug state rejects this token (state moved on, slug
              expired, tail already advanced)
```

**Sequence:**

1. **Verify token.** HMAC with the server-global signing key. Check
   `exp > :now`, decoded length, canonical base64url. On fail: 400.
2. **Upload audio** (if present) to S3 at a fresh key
   `audio/<slug_id>/<16-hex>.opus`. Keep the key in Lambda memory.
3. **Write** via `TransactWriteItems` (the `Put NODE` sets
   `audio_s3_key`, `text`, and `expires_at = token.slug_exp` —
   same TTL as META).
4. **On success:** 201 `{ }`, then fan out push to all `SUB#...`
   items for this slug, payload `{ }`. Return.
5. **On `ConditionalCheckFailed`:** return 404. The tail has
   advanced, the slug expired, or state drifted. No retry shelter.

No DynamoDB read on the hot path before the write — the signed
token carries everything the write needs: tail seq, slug TTL, and
the HMAC that proves both came from the same reveal.

`reply_token` authorizes any compose modality. Modality determines
the *next* state (text-only → next consume sets `terminal = true`),
not whether the token is valid.

**Not idempotent.** A transient proxy failure that hides a
successful server commit will show up as a 404 on retry. The
message still landed; the sender sees "turn lost" but the
confession reached the other party. At 5-min fuse with a rare
failure mode, the cost of shelter (a GetItem on every compose
attempt + a client-generated idempotency key) was larger than the
occasional confused composer. Debounce at the UI layer; don't
retry on unknown results.

### `POST /api/compose`

First-turn compose. Creates the slug. Slug is server-generated by
default; the client can optionally request a specific slug.

```
request:
  {
    audio_b64 : string | null,
    text      : string | null,    — ≤ 280 chars
    slug      : string | null     — optional; validated against slug
                                    canonicalization if present
  }

response 201:
  {
    slug : string,                 — the final slug (server-generated or echoed)
    url  : string                  — "https://confession.website/<slug>"
  }
response 400: no content, text too long, slug malformed
response 409: user-specified slug already taken (retry with a
              different name, or omit `slug` to let the server pick)
```

**Sequence:**

1. **Validate** content, sizes. Validate `slug` if provided.
2. **Upload audio** (if present) to S3 at
   `audio/<slug_candidate>/<16-hex>.opus`. If the slug is
   server-generated, use the first candidate's name for the upload
   path; retries on DDB collision reuse the same S3 key (the object
   is overwritten or re-keyed, implementer's choice).
3. Compute `:expires = :now + 7 days`.
4. **Write** via `TransactWriteItems` creating META (`tail_seq=1,
   tail_burned=false, terminal=false, created_at=:now,
   expires_at=:expires`) and NODE#000001 (with `audio_s3_key`,
   `text`, `expires_at=:expires`). `attribute_not_exists(PK)` on
   the META Put is the collision guard.
5. **On success:** 201 with the final slug and shareable URL.
6. **On `ConditionalCheckFailed`:**
   - If `slug` was user-specified: return 409. Client prompts for
     a different name.
   - If `slug` was server-generated: mint a new candidate and
     retry, up to 5 attempts. After 5 collisions, return 500.
     (Collision probability with a 1000-word list and `<word>-<word>`
     format is ~1 in 10⁶ per attempt; 5 tries is astronomical.)

First-turn composer does not receive a `reply_token` — they have
no reveal to derive one from. To send a second message, they must
wait for (or provoke) a reply, consume it, and compose within the
window.

**Slug generation.** The server picks from a curated wordlist of
~1000 common English words (ember, lantern, whisper, anchor,
quiet, signal, etc.), producing `<adjective>-<noun>` format (e.g.,
`quiet-lantern`, `amber-signal`). Short, memorable, napkin-
writable. Actual wordlist is an implementation detail.

### `POST /api/slug/<id>/subscribe`

Stores a SUB# item for Web Push fan-out.

```
request:
  {
    endpoint : string,
    p256dh   : string,
    auth     : string
  }

response 201: { }
response 404: slug doesn't exist or is expired
```

Idempotent per endpoint. Plurality cap N=4 enforced by
`Query(PK = slug#<id>, SK begins_with SUB#)` + count + evict-oldest
if at cap. The SUB item is written with `expires_at` copied from
META so DDB TTL cleans it up with the rest of the slug — this
requires one `GetItem` on META per subscribe, acceptable because
subscribe is a once-per-session-per-device operation, not on any
hot path.

## Reply token format

```
reply_token = base64url( seq_be || exp_be || slug_exp_be || hmac )  — 36 bytes decoded
  seq_be      : 4 bytes, big-endian (matches NODE.seq)
  exp_be      : 8 bytes, big-endian unix epoch (token expiry)
  slug_exp_be : 8 bytes, big-endian unix epoch (slug TTL, META.expires_at)
  hmac        : 16 bytes = HMAC-SHA256(
                  server_key,
                  "reply|" || slug_id || "|" || seq_be || "|" || exp_be
                              || "|" || slug_exp_be
                )[:16]
```

- `slug_id` is the canonical form (see
  [Slug canonicalization](#slug-canonicalization)). Router, DDB key,
  and HMAC input use the same string — no case folding or
  normalization applied anywhere between request parse and HMAC
  compute.
- `server_key` is a 32-byte random stored in SSM Parameter Store
  with KMS encryption, loaded into Lambda env at cold start.
  Rotating it invalidates all outstanding tokens — acceptable
  because all tokens are ≤ `SUBMIT_DEADLINE` old (see
  [Reply window](#reply-window--time-spans)).
- `exp = min(reveal_time + SUBMIT_DEADLINE, slug.expires_at)`, where
  `reveal_time` is the server wall clock at burn-commit.
- `slug_exp` carries META's `expires_at` verbatim so rally-compose
  can stamp the new NODE's TTL attribute without reading META.
  Signed along with `exp` and `seq` to prevent tampering.
- Verification:
  1. Base64url decode. Reject if length ≠ 36 or encoding is not
     canonical base64url (no padding, URL-safe alphabet).
  2. Split into `seq_be || exp_be || slug_exp_be || hmac`.
  3. Recompute HMAC over the same canonical input, constant-time
     compare.
  4. Check `exp > :now`.
  5. Parse `seq` as the `:token_seq` binding in the DDB condition.
  6. Use `slug_exp` as the NODE's `expires_at` on write.
- No per-slug secret. No DDB read on the compose hot path.

128-bit truncated MAC is fine at this threat model — tokens are
scoped by `slug_id` and expire within `SUBMIT_DEADLINE`, so a
forgery would need to hit a live slug's current tail within a 7-min
window.

## Reply window — time spans

Two primitives govern rally-compose. The submit deadline is derived,
not configured. The phrase "reciprocity has a fuse" in DESIGN is this
section.

| parameter       | value | definition                                       |
| --------------- | ----- | ------------------------------------------------ |
| `RESPONSE_FUSE` | 5:00  | UI countdown from reveal; the visible fuse       |
| `RECORD_TIMER`  | 2:00  | audio recording ceiling (also DESIGN's 2-min cap)|

```
SUBMIT_DEADLINE = RESPONSE_FUSE + RECORD_TIMER = 7:00
```

`SUBMIT_DEADLINE` is a calculation, not a tunable. The reasoning: a
recording that starts at `t = RESPONSE_FUSE − ε` needs up to
`RECORD_TIMER` to finish, so the server accepts POSTs up to
`RESPONSE_FUSE + RECORD_TIMER`. If `RECORD_TIMER` changes (audio
ceiling adjusts), `SUBMIT_DEADLINE` moves with it mechanically — no
independent tuning.

`reply_token.exp = min(reveal_time + SUBMIT_DEADLINE, slug.expires_at)`.
Judged at **request receipt**, not post-upload-processing, so a slow
upload doesn't penalize a user who submitted in time.

**UI phases:**

- `0 ≤ t < RESPONSE_FUSE` — **calm.** Countdown visible, compose
  affordance normal.
- `RESPONSE_FUSE ≤ t < SUBMIT_DEADLINE` — **overtime.** UI makes the
  out-of-time state obvious (spec intent: pulse-red border on the
  compose surface, countdown in alarm coloring, audible cue if audio
  context is already active). Compose affordance still works;
  submissions still accepted. User can see they're past the fuse but
  haven't been cut off.
- `t ≥ SUBMIT_DEADLINE` — **hard stop.** UI collapses the compose
  surface and transitions the page to the slug's 404 view. Any
  in-flight POST arriving server-side after `SUBMIT_DEADLINE` is
  rejected 400.

**Recording cap is dynamic.** Max audio record time at any moment
is:

```
min(RECORD_TIMER, SUBMIT_DEADLINE − t)
```

At `t = RESPONSE_FUSE` the user still gets the full `RECORD_TIMER`.
At `t = RESPONSE_FUSE + 1:00` they get 1:00. Past `SUBMIT_DEADLINE`
recording cannot start. The formula guarantees any recording started
at any `t` can finish before the submit deadline.

Text compose has no recording phase; both UI phases still apply
(text submissions accepted in calm and overtime). `RESPONSE_FUSE` is
plenty for 280 chars; the overtime exists so a mid-keystroke
submission at `RESPONSE_FUSE + ε` isn't cut.

**Re-record within overtime** is allowed iff the new recording's
expected end lands before `SUBMIT_DEADLINE`. If not, the record
button is disabled.

**`localStorage.reply_capability` is cleared at
`t = SUBMIT_DEADLINE` even without a send**, so a browser revisit
shows the 404 view cleanly.

**Drift is fine at this scale.** We're dealing with minutes, not
milliseconds. The UI countdown drifting a few seconds against the
server's wall clock is expected and harmless; the server's absolute
`token.exp` check is authoritative, and a borderline 400 at the
edge of `SUBMIT_DEADLINE` is indistinguishable from normal turn loss
from the user's perspective.

## Turn flow

### First turn — compose

1. Arrive at `confession.website/` (no slug). Landing copy.
2. (Optional) Record audio. Tap to start. Auto-stops at
   `RECORD_TIMER`. Re-recording discards and starts fresh.
3. (Optional) Listen back. (Optional) Re-record.
4. (Optional) Type text, ≤ 280 chars.
5. At least one of audio or text required. Send disabled until then.
6. Tap send. Single button. Label carries the rule:
   - Audio present → *send (keeps the rally)*
   - Text only → *send (ends the channel)*
7. `POST /api/compose` with `{audio_b64?, text?}`. No slug in the
   body — server generates.
8. On 201: server returns `{slug, url}`. Client stores a record
   under `slugs["<slug>"] = {role: "creator", created_at: now,
   reply_capability: null}`. Show the URL + share affordance.
9. (Optional before step 7) **Customize the slug.** A small
   "customize URL" affordance lets the user propose their own
   name. If taken, server returns 409; client prompts for another.
10. (Optional after step 8) Push opt-in: single button *notify
    you when a reply arrives?* Tap triggers Web Push permission
    prompt, then `POST /api/slug/<id>/subscribe`.

### Subsequent turn — consume

1. Arrive at `confession.website/<slug>`.
2. `GET /api/slug/<id>` fires. 200 → render reveal surface. 404 →
   render 404 view.
3. Reveal surface: *a message is waiting.* / *revealing plays the
   audio and shows the text once. both burn together.* / [reveal]
4. Tap reveal → `POST /api/slug/<id>/reveal`.
5. On 200:
   - Play audio (if present) from the base64-decoded body.
   - Display text (if present).
   - If `terminated = true`: transition inline to "this channel is
     done" state. No compose surface.
   - Else: write `slugs["<slug>"] = {role: "consumer", created_at:
     now, reply_capability: {token, reveal_at: now}}`. Transition
     inline to rally-compose surface with `RESPONSE_FUSE` countdown.
6. On 404: transition to 404 view. The race was lost (someone else
   revealed first, or the slug moved on).

### Subsequent turn — rally compose

Rally-compose lives only as an inline state on the post-reveal page.
There is no dedicated URL, no route, no landing surface.

1. Post-reveal page shows the just-consumed content *plus* the
   compose surface *plus* the countdown.
2. (Optional) Record audio. Dynamic duration cap (see above).
3. (Optional) Type text, ≤ 280 chars.
4. Send active for all of `t < SUBMIT_DEADLINE`; overtime UI in
   `RESPONSE_FUSE ≤ t < SUBMIT_DEADLINE`.
5. Tap send → `POST /api/slug/<id>/compose` with
   `{reply_token: slugs[slug].reply_capability.token, audio_b64?, text?}`.
6. On 201: clear `slugs[slug].reply_capability`, show "sent"
   confirmation, transition to 404 view.
7. On 400 / 404: clear `reply_capability`, transition to 404 view.
   The turn is lost.

If the user never taps send: at `t = SUBMIT_DEADLINE` the UI
auto-collapses to 404. `reply_capability` is cleared. Turn lost.

## Notifications

- **Opt-in after first send.** One prompt: *notify you when the next
  message arrives?* Tap → Web Push permission prompt →
  `POST /api/slug/<id>/subscribe`. Deny/skip → no subscription,
  manual check only.
- **One trigger: new pending message.** Push fires when a compose
  completes. Consumes fire no push.
- **Payload is empty.** Body: `{ }`. The fan-out carries no slug,
  no preview, no timestamp, no content, no exchange metadata, no
  dedup token. The push itself is the whole signal — "something
  happened, come look."
- **Self-push dedup via focused-tab check.** The service worker,
  on push receipt, calls `clients.matchAll({type: 'window'})` and
  skips notification display if any client window is focused on
  the confession.website origin. The composer just posted from a
  focused tab, so their own push is suppressed. Edge case: if the
  composer closes their tab immediately after sending, the SW sees
  no focused client and the notification fires. Minor annoyance,
  rare, not worth the complexity of explicit dedup.
- **Plurality.** Up to 4 `SUB#` items per slug. Phone + laptop on
  each side of a rally is fine. Subscribes past 4 evict the oldest.
- **Web Push only.** No email, no SMS, no account-bound push.
- **Cross-device caveat.** Push lives on the browser that subscribed.
  Visiting the slug from another device still works; only the
  subscribed browser rings.
- **Subscription dies with the slug.** `SUB#` items carry the same
  `expires_at` as META and are erased by DDB TTL alongside the rest
  of the slug.

## Architecture

- **Own domain.** Both parties visit `confession.website`. Link is
  `confession.website/<slug>`.
- **Own state.** Single DynamoDB table. Single S3 bucket for audio.
  No GSIs. Single Lambda for the API. No cron, no background
  workers, no stream processors.
- **Stack.** Go Lambda + DynamoDB + S3 + CloudFront. Mirrors
  ephemeral.website. Any equivalent is fine.
- **Cleanup is infrastructure, not code.**
  - **DDB TTL** is configured on the `expires_at` attribute. Every
    item (META, NODE, SUB) carries the same `expires_at` value on
    creation. DynamoDB deletes each item independently within ~48 h
    of TTL. No sweeper Lambda, no GSI, no pagination logic.
  - **S3 lifecycle rule** on the audio bucket: delete any object
    under the `audio/` prefix **8 days after creation**. This is
    the 7-day slug ceiling plus a 1-day margin. Audio objects can
    reach this cleanup path in two cases:
    1. **Slug expired without reveal.** The audio was never
       listened to. Nobody held the slug's reply token, nobody
       fetched the object. The lifecycle is the only path that ever
       removes it.
    2. **Reveal happened but the sync `DeleteObject` failed.** The
       audio was consumed and burned in DDB, but the Lambda's
       follow-up delete didn't land. This is the only case where
       "burned" and "still in S3" can coexist, and only until the
       lifecycle fires.
  - **Reveal Lambda does synchronous S3 `DeleteObject`** after the
    burn transaction commits (step 4 of the reveal sequence). Happy
    path: burned audio is gone from S3 within seconds of burn, not
    days. The 8-day lifecycle is the failure-mode fallback, not the
    primary cleanup path.
- **The 8-day fallback is principled, not lazy.** Data that never
  reached anyone cannot cause harm by lingering a week. Subpoenaing
  untouched audio — content nobody accessed, nobody listened to, and
  which existed only because a sender spoke into a void — would be
  a speculative fishing expedition against data that produced no
  effect in the world. If that standard were applied to any
  messaging platform, every draft, every unsent message, every
  unloaded push notification would be subpoena-eligible. The medium
  takes the position that unaccessed data is not evidence of
  anything.
- **Minimal logs, aggressively scoped.** No access logs, no
  application logs of message content, no behavioral analytics, no
  X-Ray traces capturing payloads, no visitor tracking. Content,
  slug IDs, and reply text never appear on any observability
  surface. Transient infrastructure signals (CloudWatch 500-count
  alarms, health pings, Lambda duration p99) can exist but stay
  content-free and short-retention. Debugging in production is
  intentionally hard; the cost of *aggregatable* logs is higher than
  the cost of a harder debug loop. Regulatory exposure is the
  constraint: nothing the platform writes should be worth
  subpoenaing.
- **Abuse mitigation is edge-level.** CloudFront + WAF rate limits
  on the POST endpoints by source IP. No CAPTCHA, no application-
  level identity, no account-based throttling.
- **Namespace griefing is structurally possible and accepted.**
  First-turn compose costs one request and two DynamoDB writes per
  slug name. A distributed attacker can squat the namespace of
  human-readable slugs faster than edge rate limits can stop them.
  This is a direct consequence of URL-as-credential + no-identity:
  the only response to "slug is taken" is "pick another name." No
  reservation mechanism, no reputation, no appeal. If a confession
  ends up on a squatted name, the sender picks a new name and tries
  again. The 1-week expiry means any squatted slug self-clears.
- **Storage and bandwidth amplification** via large audio uploads
  are bounded by per-request limits (≤ 1 MB body, ≤ 512 KB decoded
  audio) and edge rate limits, not by per-sender tracking. The
  absolute cost ceiling is (rate limit × 1 MB) per source IP per
  window, which is tolerable at this scale.

## What not to build

- Email or SMS notifications (identity endpoints). Web Push only.
- Read receipts beyond new-message-posted. Silent consumes never
  signal.
- Message counts, last-seen, typing indicators, presence, history.
- Voice masking or modulation.
- Cookies, accounts, or any per-visitor identity.
- Server-side drafts.
- Client-side drafts of rally-compose messages (would circumvent
  "reciprocity has a fuse").
- Retry-if-no-response prompts.
- CAPTCHAs.
- Per-sender tracking or repeat-harassment prevention (structurally
  impossible without identity — accept the trade).
- Unified inbox, thread list, cross-slug continuity.
- "CONFESSION" banner on the recipient page.
- Any "creator view" different from any other visitor's view.
- Editing or overwriting a pending message.
- Multiple pending messages queued on a slug — one at a time.
- Stateful HTTP routes for post-consume surfaces ("your turn",
  "channel is done") — these live inline in the reveal response page
  only.
- A `GET /state` endpoint with a phase enum. The two visible states
  are `200` (pending) and `404` (everything else).
- Cross-device reply-capability transfer. The reply token is
  browser-bound, intentionally.
- Distinguishable error codes for non-pending states. `no_pending`,
  `terminated`, `expired`, and `in_flight` collapse to a single
  `404` on the wire.
- Cron jobs, cleanup workers, stream processors, or any
  application-level background process. Cleanup is handled by DDB
  TTL and S3 lifecycle — infrastructure, not code.
- GSIs. The primary table's PK/SK covers every access pattern.
- A one-slug-per-browser invariant. Clients hold state for any
  number of concurrent slugs. Multiple confessions in flight is a
  legitimate use case.
- Reveal leases, acquire-lock steps, or lock nonces. Reveal is a
  straight read-read-read-write sequence; racing reveals contend
  on a single conditional burn.
- Compose idempotency via client-generated dedup keys. Transient
  hidden-success retries surface as "turn lost" — the confession
  still landed, the composer sees a rare 404.
- Push payload dedup tokens (`msg_id`). The SW uses focused-tab
  detection for self-push suppression. Push payload is empty.
- A minimum audio duration floor. A 2-second "I'm sorry." is a
  valid confession; the UI does not reject it.
- Content, slug IDs, or reply text in any log, metric, or trace.
- Retained access logs, behavioral analytics, or visitor tracking.
- Anything a subpoena or takedown notice could usefully request.
