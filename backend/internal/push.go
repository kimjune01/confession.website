package internal

import (
	"context"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// fanoutBudget is the upper bound on time rally_compose is willing to
// spend on push delivery before returning 201. Sends beyond this
// budget are cancelled and re-attempted on the next rally turn.
//
// TODO(push-async): once fanout moves to an async boundary (SQS or
// asynchronous Lambda Invoke), remove the in-request budget and let
// the worker run to completion. Keeping fanout synchronous adds this
// tail to every rally reply, which isn't ideal but is acceptable at
// N=4 subscribers per slug with a 1.5 s per-send timeout.
const fanoutBudget = 2 * time.Second

// Per-send TTL. The push service holds the wake-up for up to this
// long if the recipient is offline — 15 min is long enough to ride
// out brief network hiccups, short enough that a missed push doesn't
// notify someone a day later about a rally that's long dead.
const pushTTL = 900

// FanoutPush delivers a payload-less Web Push wake-up to every
// subscriber of a slug. Payload is intentionally empty — the service
// worker (sw.js) shows a generic "new message" notification, so no
// confession content ever touches the push service or sits in a
// browser notification buffer.
//
// Dead subscriptions (404/410 from the push service) are swept from
// DDB so the per-slug N=4 cap stays honest. Other errors are logged
// and the fan-out continues; rally_compose should bound this call
// with its own deadline so a slow push service doesn't stall the 201.
func (s *Store) FanoutPush(ctx context.Context, slug string) error {
	subs, err := s.QuerySubs(ctx, slug)
	if err != nil {
		return err
	}
	if len(subs) == 0 {
		return nil
	}

	pub := os.Getenv("VAPID_PUBLIC_KEY")
	priv := os.Getenv("VAPID_PRIVATE_KEY")
	subject := os.Getenv("VAPID_SUBJECT")
	if pub == "" || priv == "" || subject == "" {
		log.Printf("push: VAPID env vars missing, skipping fanout for %s", slug)
		return nil
	}

	// Cap total time inside fanout so a stuck push service can't eat
	// the full rally_compose deadline. All goroutines inherit this
	// ctx so they abort together when it expires.
	fanoutCtx, cancel := context.WithTimeout(ctx, fanoutBudget)
	defer cancel()

	// Per-slug topic: if two rally turns land quickly, the push
	// service collapses the queued wake-ups into one so the browser
	// isn't woken twice for the same channel.
	topic := "confession-" + slug

	// Bounded by N=4 per SPEC — unbounded goroutines are fine.
	var wg sync.WaitGroup
	for _, sub := range subs {
		wg.Add(1)
		go func(sub Sub) {
			defer wg.Done()
			s.sendOne(fanoutCtx, sub, pub, priv, subject, topic)
		}(sub)
	}
	wg.Wait()
	return nil
}

// sendOne delivers a single Web Push wake-up and handles subscription
// death (404 / 410) by removing the DDB record. All other failures
// are logged but swallowed — we don't want a flaky endpoint to
// break the compose-time fan-out.
func (s *Store) sendOne(ctx context.Context, sub Sub, pub, priv, subject, topic string) {
	subscription := &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys: webpush.Keys{
			P256dh: sub.P256dh,
			Auth:   sub.Auth,
		},
	}
	opts := &webpush.Options{
		HTTPClient:      s.PushClient,
		Subscriber:      subject,
		Topic:           topic,
		VAPIDPublicKey:  pub,
		VAPIDPrivateKey: priv,
		TTL:             pushTTL,
		Urgency:         webpush.UrgencyNormal,
	}
	resp, err := webpush.SendNotificationWithContext(ctx, []byte{}, subscription, opts)
	if err != nil {
		log.Printf("push: send to %s failed: %v", sub.SK, err)
		return
	}
	defer resp.Body.Close()

	// 404/410 mean the subscription is permanently dead. Sweep it so
	// the per-slug cap doesn't fill up with zombies. Do NOT delete
	// on 403 (VAPID misconfig — would wipe healthy subscriptions) or
	// 413 (payload too large — shouldn't happen with an empty body).
	if resp.StatusCode == http.StatusGone || resp.StatusCode == http.StatusNotFound {
		// Use the parent ctx for the delete so a late-in-budget send
		// still gets its sweep call in even if fanoutCtx is seconds
		// from expiring.
		deleteCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if derr := s.DeleteSub(deleteCtx, sub.PK, sub.SK); derr != nil {
			log.Printf("push: delete dead sub %s failed: %v", sub.SK, derr)
		}
		return
	}
	if resp.StatusCode >= 400 {
		log.Printf("push: %s returned %d", sub.SK, resp.StatusCode)
	}
}
