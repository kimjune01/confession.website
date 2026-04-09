// Package probe implements GET /api/slug/<id> — probe.
// Returns 200 {} iff META exists AND tail pending AND not terminal
// AND expires_at > :now. Everything else collapses to 404 per SPEC.
package probe

import (
	"context"

	"confession-backend/internal"

	"github.com/aws/aws-lambda-go/events"
)

var store *internal.Store

// Handler is the Lambda entry point for GET /api/slug/<id>.
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

	meta, err := store.GetMeta(ctx, slug)
	if err != nil {
		return internal.NotFound(), nil
	}
	if meta.TailBurned || meta.Terminal {
		return internal.NotFound(), nil
	}
	if meta.TailAudioS3Key == "" && meta.TailText == "" {
		return internal.NotFound(), nil
	}

	return internal.JSON(200, map[string]any{}), nil
}
