# confession.website — spec

Implementation target. Principles and stakes live in
[`DESIGN.md`](./DESIGN.md); this doc is how to build it.

## Data model

### Server — DynamoDB

One table. Composite key: `PK = slug#<id>`, `SK = META | NODE#<seq> |
SUB#<endpoint_hash>`. Two GSIs. One S3 bucket for audio blobs.

**META** — one per slug. Created on first-turn compose, destroyed on
the expiry sweep.

```
PK         = slug#<id>
SK         = META
tail_seq   : int             — seq of the current tail NODE
tail_burned: bool            — current tail has been stubbed
terminal   : bool            — channel permanently closed (text-only consume)
created_at : ISO8601
expires_at : int (epoch)     — created_at + 7d; also gsi_expires PK
```

**NODE** — one per turn. Zero-padded seq for lexicographic sort order.
Never deleted individually; erased with the slug on the expiry sweep.

```
PK              = slug#<id>
SK              = NODE#<zero-padded seq, width 6>
seq             : int
audio_s3_key    : string | absent      — e.g. audio/<slug_id>/<16-hex>.opus
text            : string | absent      — ≤ 280 chars
created_at      : ISO8601
burned          : bool                 — content has been stubbed
reveal_in_flight: bool                 — reveal lock; seq-scoped by schema placement
reveal_deadline : int (epoch) | absent — lease expiry
reveal_nonce    : bytes | absent       — lease owner; 16B random minted on acquire
cleanup_pending : int (epoch) | absent — S3 delete outstanding; also gsi_cleanup PK
msg_id          : string               — 16B client-generated hex; dedup + idempotency
```

`cleanup_pending` is present exactly when a node has been burned but
its S3 audio object has not yet been confirmed deleted. Stored as an
epoch so the reaper GSI has scan-friendly variation. Text-only burns
still set `cleanup_pending`; the reaper's `DeleteObject` is a no-op
against a missing key, keeping the reaper path uniform.

Field hygiene on burn:

- `text` is `REMOVE`'d in the burn transaction. Absence is the
  invariant.
- `audio_s3_key` **persists past burn** as a delete-pending pointer.
  The cleanup reaper reads it, calls `DeleteObject` on S3, then
  `REMOVE`s `audio_s3_key` and `cleanup_pending` together. The
  authoritative "content nulled" signal is `burned = true`, not the
  absence of `audio_s3_key`.
- `reveal_nonce` and `reveal_deadline` are `REMOVE`'d in the burn
  transaction along with `reveal_in_flight = false`.

`msg_id` is **client-generated** (16 random bytes, hex-encoded,
lowercase). The server stores it verbatim. It serves two purposes:
(1) opaque push dedup token in the fan-out payload; (2) idempotency
key for the compose retry path. See [Idempotency](#idempotency-via-msg_id)
below.

**SUB** — web push subscription. Plural per slug.

```
PK       = slug#<id>
SK       = SUB#<first8hex(sha256(endpoint))>
endpoint : string
p256dh   : string
auth     : string
added_at : ISO8601
```

`SK` is deterministic from `endpoint`, so duplicate subscribes are a
conditional put → at most one entry per endpoint. Plurality capped at
**N=4** per slug; subscribes past the cap evict the oldest by
`added_at`.

**GSIs:**

- `gsi_expires` — sparse, indexes only META items. PK = `expires_at`
  (epoch). Sweeper queries by epoch range.
- `gsi_cleanup` — sparse, indexes only NODE items with
  `cleanup_pending` present. PK = `cleanup_pending` (epoch). Reaper
  queries by epoch range.

**Atomicity contracts.** Every mutating path includes
`expires_at > :now` on META. An expired slug fails every mutation.

- **First-turn compose** — one `TransactWriteItems`:
  - `Put META`, cond `attribute_not_exists(PK)`. Collision → 409.
  - `Put NODE#000001` (no condition — first ever node in this slug).
- **Rally compose (token-gated)** — one `TransactWriteItems`:
  - `Put NODE#<token.seq+1>`, cond `attribute_not_exists(SK)`.
  - `Update META`, cond `tail_seq = :token_seq AND tail_burned = true
    AND terminal = false AND expires_at > :now`; set
    `tail_seq = :token_seq+1, tail_burned = false`. The `tail_seq`
    match is the replay guard.
- **Reveal — acquire lock** — one `UpdateItem` on NODE#<tail_seq>:
  - Cond `burned = false AND (attribute_not_exists(reveal_in_flight)
    OR reveal_in_flight = false OR reveal_deadline < :now)`.
  - Set `reveal_in_flight = true, reveal_deadline = :lambda_budget_end,
    reveal_nonce = :fresh_nonce` (16B random minted for this
    invocation).
  - `ReturnValues = ALL_NEW` so the Lambda reads back `audio_s3_key`,
    `text`, `msg_id`.
  - The nonce travels in Lambda memory through steps 2–3.
- **Reveal — commit burn** — one `TransactWriteItems`:
  - `Update NODE#<seq>`, cond `reveal_in_flight = true AND
    reveal_nonce = :fresh_nonce AND burned = false`; set
    `burned = true, reveal_in_flight = false, cleanup_pending = :now`;
    `REMOVE text, reveal_nonce, reveal_deadline`.
    `audio_s3_key` is intentionally **not** removed — the reaper
    needs it.
  - `Update META`, cond `tail_seq = :seq AND tail_burned = false AND
    expires_at > :now`; set `tail_burned = true,
    terminal = :was_text_only`.

The nonce is what makes the two-step a real lease: if Lambda A
stalls past `reveal_deadline` and Lambda B re-acquires (minting its
own `:fresh_nonce`), B's `Set` overwrites `reveal_nonce`. A's
delayed commit fails its own nonce check and is rejected. Minutes-
scale timing; don't over-tune the deadline.

Consume is idempotent within the lock window: a crashed Lambda
leaves `reveal_in_flight = true` with a past `reveal_deadline`. A
retry's acquire-lock step succeeds via the `reveal_deadline < :now`
branch, mints a fresh nonce, and proceeds from step 2. Any zombie
commit from the crashed Lambda fails the nonce check.

### Client — per-browser `localStorage`

One browser holds state for at most one slug at a time.

```
active_slug : {
  slug_id    : string,
  role       : "creator" | "consumer",
  created_at : ISO8601
}
reply_capability : {                — present iff last reveal was non-terminal
  slug_id   : string,               — gates compose on slug match
  token     : string,               — reply_token from reveal response
  reveal_at : int (epoch)           — client time; drives UI countdown
} | null
local_messages : [                  — self-push dedup + compose idempotency
  {
    msg_id     : string,            — 16B hex, client-generated at send time
    slug_id    : string,            — scopes lookup to this slug
    created_at : ISO8601,
    status     : "pending" | "confirmed" | "lost"
  }
]
```

- `active_slug` prevents starting a new confession while an existing
  one is alive. Starting a new one from the landing page while
  `active_slug` is set redirects to the existing slug. User waits
  for expiry or manually clears storage to abandon.
- `reply_capability` is set on successful reveal (non-terminal) and
  cleared on successful rally-compose **or** on countdown expiry
  (`reveal_at + SUBMIT_DEADLINE < :now`). Compose is blocked unless
  `reply_capability.slug_id` matches the slug being composed into.
- `local_messages` holds `msg_id`s of messages this browser has
  composed. Entry is added with `status = "pending"` **immediately
  before** the compose POST fires — this closes the self-push race
  where a server-side push fanout arrives before the client stores
  its own msg_id. On 201 → `"confirmed"`. On 400/404 →
  `"lost"` (kept long enough for dedup GC, then dropped).
- The service worker, on Web Push receipt, looks up the incoming
  `msg_id` in `local_messages`. Any non-absent status (`pending`,
  `confirmed`, `lost`) suppresses the notification — if this
  browser ever tried to compose that message, it's not a new
  message from the other party.
- Clearing `localStorage` abandons the slug permanently from this
  browser's perspective. The server has no way to reconnect.

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
- `msg_id` is exactly 32 lowercase hex characters (16 bytes).
- `reply_token` base64url decodes to exactly 28 bytes
  (4 seq + 8 exp + 16 hmac). Non-canonical base64url is rejected.

### `GET /api/slug/<id>`

Probe. Bare body — no metadata leakage (not even `has_audio` /
`has_text`).

```
200 { }    — META exists AND tail pending AND not terminal AND not expired
404 { }    — everything else
```

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
              terminated, expired, already-in-flight, race lost)
```

**Sequence:**

1. **Acquire lock** on `NODE#<tail_seq>`. Mint `:fresh_nonce` for
   this Lambda invocation. Issue `UpdateItem` with
   `ReturnValues = ALL_NEW` to read back the NODE state (audio key,
   text, msg_id, seq). On condition failure: 404.
2. **Read audio** from S3 if `audio_s3_key` present. On failure:
   best-effort clear `reveal_in_flight` (conditional on the same
   nonce), return 404.
3. **Commit burn** via `TransactWriteItems` as described above,
   carrying `:fresh_nonce` in the NODE condition.
4. **Mint `reply_token`** — see [Reply token format](#reply-token-format).
   `null` if the burn set `terminal = true`.
5. **Return body** containing content bytes (as base64) and token.

**At-most-once delivery, sharpened.** If the burn transaction in
step 3 commits but the response never reaches the client (disconnect,
crash, proxy hang), the message is burned unread *and* no
`reply_token` was delivered. The slug is immediately dead: nothing to
reveal (content stubbed), no token to compose (never received). The
1-week sweep eventually erases the husk. This is not a bug — it is
the cost of burn guarantees. The medium trades delivery certainty
for burn certainty. Aligned with "bravery deserves closure, not
extraction" in DESIGN.md.

### `POST /api/slug/<id>/compose`

Rally-compose. Token-gated. Distinct endpoint from first-turn compose.

```
request:
  {
    reply_token : string,
    msg_id      : string,          — 32 hex chars; client-generated
    audio_b64   : string | null,
    text        : string | null    — ≤ 280 chars
  }
  At least one of audio_b64 or text required.

response 201: { }
response 400: token invalid, token expired, no content, text too long,
              msg_id malformed
response 404: slug state rejects this token and the NODE at
              token.seq+1 does not match this msg_id (state moved on,
              slug expired, real collision)
```

**Sequence:**

1. **Verify token.** HMAC with the server-global signing key. Check
   `exp > :now`, decoded length, canonical base64url. On fail: 400.
2. **Upload audio** (if present) to S3 at a fresh key
   `audio/<slug_id>/<16-hex>.opus`. Keep the key in Lambda memory.
3. **Write** via `TransactWriteItems` (the `Put NODE` sets
   `msg_id`, `audio_s3_key`, `text`).
4. **On success:** 201 `{ }`, then fan out push to all `SUB#...`
   items for this slug, payload `{ msg_id }`. Return.
5. **On `ConditionalCheckFailed`:** run the idempotency handler —
   see [Idempotency via msg_id](#idempotency-via-msg_id). Either
   returns 201 (matching retry) or 404 (real state drift).

No DynamoDB read on the hot path before the write — the global
signing key makes token verify purely local. The only read happens
on the rare idempotency branch.

`reply_token` authorizes any compose modality. Modality determines
the *next* state (text-only → next consume sets `terminal = true`),
not whether the token is valid.

### `POST /api/slug/<id>`

First-turn compose. Creates the slug.

```
request:
  {
    msg_id    : string,           — 32 hex chars; client-generated
    audio_b64 : string | null,
    text      : string | null     — ≤ 280 chars
  }

response 201: { }
response 400: no content, text too long, msg_id malformed
response 409: real slug collision (NODE#000001 msg_id does not match)
```

**Sequence:**

1. **Validate** content, sizes, msg_id format.
2. **Upload audio** (if present) to S3.
3. **Write** via `TransactWriteItems` creating META (`tail_seq=1,
   tail_burned=false, terminal=false, created_at=:now,
   expires_at=:now+7d`) and NODE#000001 (with request's `msg_id`).
   `attribute_not_exists(PK)` on the META Put is the collision guard.
4. **On success:** 201 `{ }`.
5. **On `ConditionalCheckFailed`:** run the idempotency handler —
   see below. Either returns 201 (matching retry) or 409 (real
   collision).

First-turn composer does not receive a `reply_token` — they have no
reveal to derive one from. To send a second message, they must wait
for (or provoke) a reply, consume it, and compose within the window.

### Idempotency via msg_id

The `msg_id` is a client-generated 16B random, meant to survive
retries through transient proxy failures where a successful server-
side commit is masked by a lost response. On the `ConditionalCheckFailed`
branch of any compose endpoint:

1. `GetItem` on `NODE#<target_seq>` (for rally-compose,
   `target_seq = token.seq + 1`; for first-turn,
   `target_seq = 000001`).
2. If the item exists and its `msg_id` matches the request's: return
   201 `{ }`. This is an idempotent retry of a successful compose —
   do **not** re-fire push fan-out (the original attempt already did,
   or tried to).
3. Otherwise: return the state-appropriate failure (404 for
   rally-compose, 409 for first-turn).

This is the only DDB read on the compose path, and it only runs when
the write conditionally fails. Hot-path compose is still write-only.

The collision probability for 16B random msg_ids is negligible at
any realistic volume; treat a match as proof of retry, not accident.

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
if at cap.

## Reply token format

```
reply_token = base64url( seq_be || exp_be || hmac )     — 28 bytes decoded
  seq_be : 4 bytes, big-endian (matches NODE.seq)
  exp_be : 8 bytes, big-endian unix epoch
  hmac   : 16 bytes = HMAC-SHA256(
             server_key,
             "reply|" || slug_id || "|" || seq_be || "|" || exp_be
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
- Verification:
  1. Base64url decode. Reject if length ≠ 28 or encoding is not
     canonical base64url (no padding, URL-safe alphabet).
  2. Split into `seq_be || exp_be || hmac`.
  3. Recompute HMAC over the same canonical input, constant-time
     compare.
  4. Check `exp > :now`.
  5. Parse `seq` as the `:token_seq` binding in the DDB condition.
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
2. (Optional) Record audio. Tap to start. Stop locked for first 6s.
   Auto-stops at `RECORD_TIMER`.
3. (Optional) Listen back. (Optional) Re-record.
4. (Optional) Type text, ≤ 280 chars.
5. At least one of audio or text required. Send disabled until then.
6. Pick a slug name. Short, writable on a napkin.
7. Tap send. Single button. Label carries the rule:
   - Audio present → *send (keeps the rally)*
   - Text only → *send (ends the channel)*
8. **Before POST**, generate `msg_id` (16 random bytes → 32 hex)
   and append to `local_messages` with `status = "pending"` and
   `slug_id = <the slug name>`.
9. `POST /api/slug/<id>` with `{msg_id, audio_b64?, text?}`. On 201:
   flip `local_messages[msg_id].status = "confirmed"`, set
   `active_slug`, show URL + share affordance. On 409: flip to
   `"lost"` and prompt for a new slug name. On transport failure
   (unknown outcome): retry POST with the same `msg_id` — if the
   original landed, the server recognizes the msg_id and returns
   201; if not, the retry succeeds fresh.
10. (Optional) Push opt-in after send: single button *notify you
    when the next message arrives?* Tap triggers Web Push permission
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
   - Else: set `localStorage.reply_capability =
     {slug_id, token, reveal_at: now}`. Transition inline to
     rally-compose surface with `RESPONSE_FUSE` countdown.
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
5. **Before POST**, verify `reply_capability.slug_id` matches the
   current slug; if not, bail. Generate `msg_id` and append to
   `local_messages` with `status = "pending"` and `slug_id`.
6. Tap send → `POST /api/slug/<id>/compose` with
   `{reply_token: reply_capability.token, msg_id, audio_b64?, text?}`.
7. On 201: flip `local_messages[msg_id].status = "confirmed"`,
   clear `reply_capability`, show "sent" confirmation, transition
   to 404 view.
8. On 400 / 404: flip to `"lost"`, clear `reply_capability`,
   transition to 404 view. The turn is lost. (The server's
   idempotency handler means a 201 is still possible on retry if
   the original actually landed.)

If the user never taps send: at `t = SUBMIT_DEADLINE` the UI
auto-collapses to 404. `reply_capability` is cleared. Turn lost.

## Notifications

- **Opt-in after first send.** One prompt: *notify you when the next
  message arrives?* Tap → Web Push permission prompt →
  `POST /api/slug/<id>/subscribe`. Deny/skip → no subscription,
  manual check only.
- **One trigger: new pending message.** Push fires when a compose
  completes. Consumes fire no push.
- **Payload is opaque.** Body: `{ msg_id: "<hex>" }`. No slug, no
  preview, no timestamp, no content, no exchange metadata. The
  `msg_id` is the 16B client-generated random from the composer's
  POST; unique and uncorrelatable across slugs.
- **Self-push dedup is client-side.** The service worker matches
  incoming `msg_id` against `local_messages` in localStorage. Any
  non-absent entry (pending, confirmed, or lost) suppresses display.
  The "pending before POST" rule closes the race where a server
  fan-out reaches the subscribed browser before the compose response:
  the msg_id is already in local_messages by the time the push
  arrives, because the client wrote it there before firing the POST.
  Push still fires server-side; the subscribed browser just doesn't
  surface it.
- **Plurality.** Up to 4 `SUB#` items per slug. Phone + laptop on
  each side of a rally is fine. Subscribes past 4 evict the oldest.
- **Web Push only.** No email, no SMS, no account-bound push.
- **Cross-device caveat.** Push lives on the browser that subscribed.
  Visiting the slug from another device still works; only the
  subscribed browser rings.
- **Subscription dies with the slug.** `SUB#` items are erased in
  the expiry sweep along with META and NODEs.

## Architecture

- **Own domain.** Both parties visit `confession.website`. Link is
  `confession.website/<slug>`.
- **Own state.** Single DynamoDB table. Single S3 bucket for audio.
  Two GSIs (`gsi_expires`, `gsi_cleanup`). Single Lambda for the API.
- **Stack.** Go Lambda + DynamoDB + S3 + CloudFront. Mirrors
  ephemeral.website. Any equivalent is fine.
- **Background jobs.**
  - **Expiry sweeper** — cron, every 10 min. Queries `gsi_expires`
    for METAs with `expires_at ≤ :now`. For each slug:
    1. `Query(PK = slug#<id>)` paginated.
    2. For each NODE with `audio_s3_key` present, `DeleteObject`.
    3. `BatchWriteItem` delete all NODE and SUB items in 25-item
       chunks.
    4. **Delete META last.** The META row is the source of truth
       for `gsi_expires`; if it's deleted before the other items,
       a crash at any point afterwards orphans them beyond the
       sweeper's reach. META-last makes the sweep crash-safe —
       a crashed run leaves the slug re-discoverable via
       `gsi_expires` on the next cron tick.
    Idempotent across runs.
  - **Cleanup reaper** — cron, every 5 min. Queries `gsi_cleanup`
    for NODEs with `cleanup_pending ≤ :now`. For each:
    1. Read `audio_s3_key` (it persists past burn specifically for
       this reason).
    2. `DeleteObject` S3. NoSuchKey is a success.
    3. `UpdateItem` `REMOVE audio_s3_key, cleanup_pending` on the
       NODE.
    Idempotent — a partial-failure rerun converges, because step 3
    only runs after step 2 succeeded, and the GSI sparse index
    drops the item once `cleanup_pending` is removed.
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
- Content, slug IDs, or reply text in any log, metric, or trace.
- Retained access logs, behavioral analytics, or visitor tracking.
- Anything a subpoena or takedown notice could usefully request.
