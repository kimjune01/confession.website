# confession.website — design

The principles and stakes of the medium. Companion to the blog post
[`/i-am-now-sending-to-you`](https://june.kim/i-am-now-sending-to-you).

For how to build it, see [`SPEC.md`](./SPEC.md).

## Scope

**Honest messaging at the fringes of social reach, where the message
requires the possibility of reply to be complete.** The sender offers
space for a response as part of the message itself; that space can
host a single reply or a turn-based rally bounded by time.

**In scope:** apology to someone unreachable, declaration to a stranger,
compliment + ask for voluntary contact handoff, hard questions to the
unreachable.

**Out of scope:**
- Appreciation without ask → ephemeral.website (purely outbound, no slot).
- Messages to anyone the sender already has a channel to.
- 1 AM impulse confessions to people the sender knows. Accept the loss.
- Messages intended to build a persistent relationship from scratch.

## Ethos

- **Phone numbers are bilateral; links are unilateral.** Structural
  foundation — a messaging app built on phone numbers cannot host this.
- **No audience, at any timescale.** Not future-self, not strangers on a
  phone, not friends at a shared table during the handoff.
- **Silence is a first-class response, but burn is the receipt.** The
  site never pressures, nags, retries, or reminds. Silent consumes
  produce no push — but the slug's surface collapses when a message
  is consumed (pending → 404), and the sender can see that by
  revisiting the link. Closure is observable by pull, not delivered
  by push. The 404 is the receipt.
- **Reciprocity has a fuse.** Rally-compose lives in a 5-minute
  window opened by reveal, with a 2-minute grace for in-progress
  recording. The fuse burns on engagement, not on URL-holding —
  the capability to reply is minted fresh at each reveal and
  expires with the window. Decay is part of the gesture: a reply
  that comes an hour later isn't the same reply.
- **The URL is the whole credential, fragment included.** During
  the reply window the URL carries a short-lived reply token in
  its hash fragment. Copying the URL between your own devices to
  reply from a different one — laptop with no mic, phone with a
  better keyboard, whatever — is a feature. Sharing the URL
  during the window hands the reply capability to whoever
  receives it; this is the same trust model as sharing any URL
  from the site, consistently applied. Outside the window, the
  fragment is empty and the URL points at plain state.
- **The site refuses to extract, observe, or escalate.** The only
  active signal is "a new message is waiting" (push). Everything else
  — whether the previous message was consumed, whether the channel
  has been terminated — is visible only by pulling the slug state.
- **Nothing to hand over.** No retained message content, no access
  history, no visitor tracking, no behavioral analytics. Operational
  traces (error signals, uptime health) exist but are transient,
  content-free, and not aggregated. The goal is regulatory exposure
  minimization, not purism: when a subpoena or takedown demand arrives,
  the platform has nothing to produce. "Platform" is in scare quotes —
  nobody should be able to come after it because there's no *it* to
  come after.
- **Unaccessed data is not evidence.** Burned audio is deleted from
  storage within seconds of the burn, synchronously. Audio that was
  *never* listened to — someone spoke into a void, nobody came — is
  cleaned up by infrastructure lifecycle, not by application code.
  The untouched object may sit in storage for a few days before the
  lifecycle runs. This is fine. Subpoenaing data that nobody ever
  accessed, that produced no effect in the world, that exists only
  because a sender spoke and no one was there, is a speculative
  fishing expedition on the potential for harm — not on harm itself.
  Applied consistently, that standard would make every draft, every
  unsent message, and every unloaded push across every platform
  subpoena-eligible. The medium takes the position that
  unaccessed data is not evidence of anything.
- **Voice is selective identity. No masking, ever.** Refusing to help the
  speaker hide from the listener is principled; masking reproduces
  Sarahah's "anonymity on the wrong side" failure.
- **Seventeen-year-old test at every surface.** Any feature that helps a
  sender extract, observe, or escalate against a recipient who can't
  gracefully refuse is rejected.
- **Explicit rules, playful shape.** The channel is a turn-based rally
  with a terminator. The rules — audio continues, text ends; burn on
  consume; 1-week expiry; no logs — are surfaced at the moments they
  matter, not hidden in FAQs or legal copy. The tennis invites play;
  play requires understood rules.
- **Options are ephemeral.** Rally, terminate, silence — all exist only
  within the window. Every choice, including inaction, consumes the
  clock. No stasis.
- **Termination is unilateral.** Either side can end the channel with
  text; the other cannot refuse. Asymmetric play resolves in the
  terminator's favor.
- **Bravery deserves closure, not extraction.** Sending a voice note is
  vulnerable. The rules ensure the sender gets either reciprocity
  (voice back → rally continues) or clean closure (text back → channel
  ends) — never the asymmetric trap of being kept talking while the
  other side stays safe in text. Text-as-terminator is the fairness
  lock. It protects voice-senders from one-sided extraction.
- **Not a messaging app.** Third-party link forwarding, impersonation,
  and abuse mitigation are outside the threat model. The sender's
  choice of who receives the URL is the trust mechanism; adding
  identity infrastructure would collapse the unilateral-link property
  the medium rests on.
- **Not a secure channel.** Ephemeral, not cryptographic. No
  end-to-end encryption, no authentication, no protection against
  interception or forwarding. This is a social medium with a
  burn-on-consume policy — not Signal, and it does not pretend to be.
  Trust it for fringe confessions, not for things that would need to
  hold up in court.

## The medium

**A message is audio and/or text.** Voice (up to 2-minute ceiling)
and/or text (≤280 chars). At least one required. Both burn together
on consume. No minimum duration — a two-second *"I'm sorry."* is a
valid confession.

**Conversation tennis.** After the first message, the slug is a
turn-based exchange. Audio keeps the rally going. **Text-only
terminates.** The slug holds one pending message at a time; compose is
blocked while one exists.

**Bounded by time.** 1-week expiry from creation. Turn count is
unlimited within the window.

**URL-as-credential.** No cookies, no accounts, no identity. Whoever
holds the slug has the slug's privileges. The link doesn't
discriminate, it just serves.

**Footguns are accepted.** Anyone with the URL can consume. First-turn
compose is also URL-gated — any fresh slug name is available to any
visitor. Rally-compose is not: it requires a reply token minted at
reveal. Visiting your own link can burn your own messages. The cost
of the no-discrimination principle.

**Contact handoff is an exit door.** If a message's text contains a
phone number or handle, the receiver can leave for a persistent
channel. The site's job ends there.

## Copy

The rules should be visible at every moment a user makes a decision.
Drafts below — shape fixed, words need another pass.

**Landing page (confession.website, no slug):**
> *a voice channel for things you can't say in person.*
> *one week. burns when heard. audio keeps it going. text ends it.*
> [record] [or type]

**Slug with pending message:**
> *a message is waiting.*
> *revealing plays the audio and shows the text once. both burn together.*
> [reveal]

**Post-reveal, inline (non-terminal).** After reveal, the same page
shows the content and, below it, the compose surface with a countdown.
The rally-compose UI is not a separate route; it lives in the reveal
response page.
> *your turn.*
> *audio keeps the rally going. text ends the channel.*
> [record] [or type]
> (5:00 countdown; 5:00–7:00 overtime with obvious animation; hard
> stop at 7:00)

**Post-reveal, inline (terminal, text-only message):** same page
shows the content, then:
> *this channel is done.*

**Slug 404 (everything except a pending message — burned-empty,
terminated, expired, never-existed):**
> *nothing here.*

**Send button labels:**
- audio present → *send (keeps the rally)*
- text only → *send (ends the channel)*

**Push notification:**
> *a new message on confession.website*

## Open questions

1. **Final copy polish.** The drafts above capture the shape; the words
   need another pass.
2. **Overtime animation.** SPEC says the 5:00–7:00 overtime window
   needs obvious UI. Exact design — pulse, color, audible cue — is
   open.
3. **Text content floor.** Probably not needed — text is inherently
   light.
