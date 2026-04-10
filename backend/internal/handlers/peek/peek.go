// Package peek implements GET /api/slug/<id>/peek — read-only audio
// retrieval. Returns the pending message's audio and text without
// burning. The client uses this to preload audio during the 3 s
// listen countdown; the actual burn happens via POST /listen after
// playback starts.
package peek

import (
	"context"
	"encoding/base64"

	"confession-backend/internal"

	"github.com/aws/aws-lambda-go/events"
)

var store *internal.Store

type response struct {
	Text      *string `json:"text"`
	AudioMIME *string `json:"audio_mime"`
	AudioB64  *string `json:"audio_b64"`
}

// Handler is the Lambda entry point for GET /api/slug/<id>/peek.
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

	resp := response{}

	if meta.TailText != "" {
		t := meta.TailText
		resp.Text = &t
	}
	if meta.TailAudioS3Key != "" {
		audioBytes, audioMIME, err := store.GetAudio(ctx, meta.TailAudioS3Key)
		if err != nil {
			return internal.NotFound(), nil
		}
		m := audioMIME
		resp.AudioMIME = &m
		b := base64.StdEncoding.EncodeToString(audioBytes)
		resp.AudioB64 = &b
	}

	return internal.JSON(200, resp), nil
}
