// Package listen implements POST /api/slug/<id>/listen — atomic burn.
// Sequence per SPEC §POST /api/slug/<id>/listen:
//  1. Read META, validate pending + not terminal + not expired.
//  2. Read audio from S3 if present.
//  3. Mint fresh reply_code in Lambda memory.
//  4. Try burn UpdateItem with that code. Winner sets reply_code +
//     reply_code_exp. Loser returns content with both null.
//  5. On winner success: sync DeleteObject S3.
package listen

import (
	"context"
	"encoding/base64"

	"confession-backend/internal"

	"github.com/aws/aws-lambda-go/events"
)

var store *internal.Store

type response struct {
	Text         *string `json:"text"`
	AudioMIME    *string `json:"audio_mime"`
	AudioB64     *string `json:"audio_b64"`
	Terminated   bool    `json:"terminated"`
	ReplyCode    *string `json:"reply_code"`
	ReplyCodeExp *int64  `json:"reply_code_exp"`
}

// Handler is the Lambda entry point for POST /api/slug/<id>/listen.
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

	// Snapshot content for the response before the burn.
	tailSeq := meta.TailSeq
	tailAudioKey := meta.TailAudioS3Key
	tailText := meta.TailText

	var audioBytes []byte
	var audioMIME string
	if tailAudioKey != "" {
		audioBytes, audioMIME, err = store.GetAudio(ctx, tailAudioKey)
		if err != nil {
			// No writes yet — nothing to clean up.
			return internal.NotFound(), nil
		}
	}

	// Terminal = text-only consume closes the channel.
	wasTextOnly := tailAudioKey == "" && tailText != ""

	// Mint the fresh reply_code before attempting the burn. Losers
	// generate one too (it's cheap); only winners persist it.
	freshCode := internal.GenerateReplyCode()
	nowUnix := internal.Now().Unix()
	freshCodeExp := internal.ClampReplyExp(nowUnix, meta.ExpiresAt)

	burnErr := store.UpdateMetaBurn(ctx, slug, tailSeq, wasTextOnly, freshCode, freshCodeExp)

	// Build response body. Pointer fields produce literal `null` on
	// the wire when nil, per SPEC §HTTP API response shape.
	resp := response{
		Terminated: wasTextOnly,
	}
	if tailText != "" {
		t := tailText
		resp.Text = &t
	}
	if tailAudioKey != "" {
		m := audioMIME
		resp.AudioMIME = &m
		b := base64.StdEncoding.EncodeToString(audioBytes)
		resp.AudioB64 = &b
	}

	if burnErr == nil {
		// Winner: persist reply code (unless terminal) and sync
		// delete S3. Loser skips both.
		if !wasTextOnly {
			c := freshCode
			e := freshCodeExp
			resp.ReplyCode = &c
			resp.ReplyCodeExp = &e
		}
		if tailAudioKey != "" {
			// Best-effort sync delete. Per SPEC §Architecture the
			// 8-day S3 lifecycle rule is the fallback if this
			// fails; we don't surface the error to the client
			// because the burn has already committed and the
			// content has already been delivered.
			_ = store.DeleteAudio(ctx, tailAudioKey)
		}
		return internal.JSON(200, resp), nil
	}

	if burnErr == internal.ErrCondition {
		// Burn race loser. Return content, leave reply_code null,
		// do NOT delete S3 (winner handles it).
		return internal.JSON(200, resp), nil
	}

	return internal.Error(500, "internal error"), nil
}
