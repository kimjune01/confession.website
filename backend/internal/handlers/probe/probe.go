// Package probe implements GET /api/slug/<id> — probe.
// Returns 200 when the slug has a pending message OR an open reply
// window (tail burned but reply_code_exp > now). Everything else
// collapses to 404.
package probe

import (
	"context"
	"time"

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

	resp := map[string]any{}
	if meta.ReplyCodeExp > 0 {
		resp["reply_code_exp"] = meta.ReplyCodeExp
	}

	// Case 1: tail burned or terminal — the message has been consumed.
	// Still return 200 if the reply window is open so a refreshed
	// recipient can see the countdown and reply.
	if meta.TailBurned || meta.Terminal {
		if meta.ReplyCodeExp > 0 && meta.ReplyCodeExp > time.Now().Unix() {
			resp["replyable"] = true
			return internal.JSON(200, resp), nil
		}
		return internal.NotFound(), nil
	}

	// Case 2: pending message (not burned, not terminal).
	if meta.TailAudioS3Key == "" && meta.TailText == "" {
		return internal.NotFound(), nil
	}

	return internal.JSON(200, resp), nil
}
