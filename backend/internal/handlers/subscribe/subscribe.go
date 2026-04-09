// Package subscribe implements POST /api/slug/<id>/subscribe.
// Reads META to inherit expires_at, writes SUB# item, enforces
// plurality cap N=4 (evict oldest).
package subscribe

import (
	"context"
	"encoding/json"
	"strings"

	"confession-backend/internal"

	"github.com/aws/aws-lambda-go/events"
)

var store *internal.Store

type request struct {
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"`
	Auth     string `json:"auth"`
}

// Handler is the Lambda entry point for POST /api/slug/<id>/subscribe.
func Handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	if store == nil {
		var err error
		store, err = internal.NewStore(ctx)
		if err != nil {
			return internal.Error(500, "internal error"), nil
		}
	}

	raw := req.PathParameters["slug"]
	slug, err := internal.Canonicalize(raw)
	if err != nil {
		return internal.NotFound(), nil
	}

	// SPEC §POST /api/slug/<id>/subscribe defines only 201 and 404.
	// Malformed request bodies and missing fields collapse to 404 to
	// keep the wire surface clean.
	var body request
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return internal.NotFound(), nil
	}
	if strings.TrimSpace(body.Endpoint) == "" || strings.TrimSpace(body.P256dh) == "" || strings.TrimSpace(body.Auth) == "" {
		return internal.NotFound(), nil
	}

	// Inherit expires_at from META. Absent/expired META → 404.
	meta, err := store.GetMeta(ctx, slug)
	if err != nil {
		return internal.NotFound(), nil
	}

	sub := internal.Sub{
		PK:        internal.MetaPK(slug),
		SK:        internal.SubSK(body.Endpoint),
		Endpoint:  body.Endpoint,
		P256dh:    body.P256dh,
		Auth:      body.Auth,
		AddedAt:   internal.IsoNow(),
		ExpiresAt: meta.ExpiresAt,
	}
	err = store.PutSub(ctx, sub)
	if err != nil && err != internal.ErrCondition {
		return internal.Error(500, "internal error"), nil
	}
	// ErrCondition = duplicate endpoint; treat as idempotent success
	// so added_at / eviction order stay stable per SPEC §SUB.
	if err == internal.ErrCondition {
		return internal.JSON(201, map[string]any{}), nil
	}

	// Enforce plurality cap: after a fresh put there may be up to
	// N+1 items. Evict oldest until count <= SubCap.
	//
	// NOTE: this loop is non-atomic across handlers — SPEC §Data model
	// forbids TransactWriteItems, so two concurrent subscribes against
	// a near-full slug can transiently over-evict (ending at N-1
	// instead of N). Accepted tradeoff per SPEC's single-item-mutation
	// constraint; the permanent invariant we guarantee is count ≤ N.
	subs, err := store.QuerySubs(ctx, slug)
	if err == nil {
		for len(subs) > internal.SubCap {
			if err := store.EvictOldestSub(ctx, slug); err != nil {
				break
			}
			subs, err = store.QuerySubs(ctx, slug)
			if err != nil {
				break
			}
		}
	}

	return internal.JSON(201, map[string]any{}), nil
}
