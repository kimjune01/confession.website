// Package rally_compose implements POST /api/slug/<id>/compose.
// Code-gated; the reply_code on the request must match the one
// previously minted by a listen burn. UpdateMetaCompose REMOVEs
// reply_code on success so replays naturally fail.
package rally_compose

import (
	"context"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"confession-backend/internal"

	"github.com/aws/aws-lambda-go/events"
	"golang.org/x/text/unicode/norm"
)

const maxTextChars = 280

var store *internal.Store

type request struct {
	ReplyCode string `json:"reply_code"`
	AudioB64  string `json:"audio_b64"`
	AudioMIME string `json:"audio_mime"`
	Text      string `json:"text"`
}

// Handler is the Lambda entry point for POST /api/slug/<id>/compose.
func Handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	if store == nil {
		var err error
		store, err = internal.NewStore(ctx)
		if err != nil {
			return internal.Error(500, "internal error"), nil
		}
	}

	// Capture request-receipt time BEFORE upload so a slow upload
	// doesn't eat into the user's reply window. Per SPEC §Reply window:
	// "Judged at request receipt, not post-upload-processing."
	requestNow := internal.Now().Unix()

	raw := req.PathParameters["slug"]
	slug, err := internal.Canonicalize(raw)
	if err != nil {
		return internal.NotFound(), nil
	}

	var body request
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return internal.Error(400, "invalid JSON body"), nil
	}

	// Normalize and validate the reply code per SPEC §HTTP API wire
	// limits: uppercased, dashes/whitespace stripped, exactly 4 chars
	// from the crockford base32 alphabet.
	code, ok := internal.NormalizeReplyCode(body.ReplyCode)
	if !ok {
		return internal.Error(400, "reply_code malformed"), nil
	}

	text := norm.NFC.String(strings.TrimSpace(body.Text))
	hasText := text != ""
	hasAudio := strings.TrimSpace(body.AudioB64) != ""
	if !hasText && !hasAudio {
		return internal.Error(400, "no content"), nil
	}
	if hasText && utf8.RuneCountInString(text) > maxTextChars {
		return internal.Error(400, "text too long"), nil
	}

	var audioBytes []byte
	if hasAudio {
		if !internal.ValidateAudioMIME(body.AudioMIME) {
			return internal.Error(400, "unsupported audio_mime"), nil
		}
		var err error
		audioBytes, err = internal.DecodeAndValidate(body.AudioB64)
		if err != nil {
			return internal.Error(400, "invalid audio_b64"), nil
		}
	}

	// Upload audio to a fresh key before the DDB write. If the
	// conditional update fails (code consumed/expired/slug gone),
	// best-effort clean up the orphan — S3 lifecycle catches any
	// we miss.
	audioKey := ""
	if hasAudio {
		audioKey = internal.NewAudioKey(slug)
		if err := store.UploadAudio(ctx, audioKey, audioBytes, body.AudioMIME); err != nil {
			return internal.Error(500, "internal error"), nil
		}
	}

	err = store.UpdateMetaCompose(ctx, slug, requestNow, code, audioKey, text)
	if err != nil {
		if audioKey != "" {
			_ = store.DeleteAudio(ctx, audioKey)
		}
		if err == internal.ErrCondition {
			// Code consumed, expired, slug gone, or tail_burned
			// drifted. All collapse to 404 per SPEC §collapse rule.
			return internal.NotFound(), nil
		}
		return internal.Error(500, "internal error"), nil
	}

	// Fan out push to subscribers. Stub no-op for M3; must not block
	// the 201 on failure.
	_ = store.FanoutPush(ctx, slug)

	return internal.JSON(201, map[string]any{}), nil
}
