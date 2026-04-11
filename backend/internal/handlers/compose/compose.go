// Package compose implements POST /api/compose — first-turn compose.
// Creates the slug, uploads audio (if any), writes META with tail_seq=1.
package compose

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

// slugRetryBudget matches SPEC §POST /api/compose: "retry, up to 5
// attempts. After 5 collisions, return 500."
const slugRetryBudget = 5

var store *internal.Store

type request struct {
	AudioB64  string `json:"audio_b64"`
	AudioMIME string `json:"audio_mime"`
	Text      string `json:"text"`
	Slug      string `json:"slug"`
}

type response struct {
	Slug string `json:"slug"`
	URL  string `json:"url"`
}

// Handler is the Lambda entry point for POST /api/compose.
func Handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	if store == nil {
		var err error
		store, err = internal.NewStore(ctx)
		if err != nil {
			return internal.Error(500, "internal error"), nil
		}
	}

	var body request
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return internal.Error(400, "invalid JSON body"), nil
	}

	// NFC-normalize text at parse (SPEC §HTTP API wire limits).
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

	// Validate user-provided slug, or prepare to generate.
	userSlug := ""
	if body.Slug != "" {
		var err error
		userSlug, err = internal.Canonicalize(body.Slug)
		if err != nil {
			return internal.Error(400, "slug malformed"), nil
		}
	}

	now := internal.Now()
	nowUnix := now.Unix()
	expiresAt := nowUnix + int64(internal.SlugTTLDuration.Seconds())
	createdAt := internal.IsoNow()

	// Retry loop for server-generated slugs. User-specified slugs
	// get exactly one attempt (409 on collision).
	var slug string
	maxAttempts := slugRetryBudget
	if userSlug != "" {
		maxAttempts = 1
	}

	for attempt := 0; attempt < maxAttempts; attempt++ {
		if userSlug != "" {
			slug = userSlug
		} else {
			slug = internal.GenerateSlug()
		}

		// Upload audio first so the key exists before the META write.
		// On any META write failure the orphaned blob is best-effort
		// deleted below; the 8-day S3 lifecycle rule is the fallback.
		audioKey := ""
		if hasAudio {
			audioKey = internal.NewAudioKey(slug)
			if err := store.UploadAudio(ctx, audioKey, audioBytes, body.AudioMIME); err != nil {
				return internal.Error(500, "internal error"), nil
			}
		}

		meta := internal.Meta{
			PK:             internal.MetaPK(slug),
			SK:             "META",
			TailSeq:        1,
			TailBurned:     false,
			Terminal:       false,
			TailAudioS3Key: audioKey,
			TailText:       text,
			CreatedAt:      createdAt,
			ExpiresAt:      expiresAt,
		}

		err := store.PutMeta(ctx, meta)
		if err == nil {
			// Bump the daily confession counter. Synchronous but
			// errors are swallowed — a failed counter shouldn't
			// block the 201.
			store.IncrementDailyCount(ctx)
			return internal.JSON(201, response{
				Slug: slug,
				URL:  "https://confession.website/" + slug,
			}), nil
		}
		if audioKey != "" {
			_ = store.DeleteAudio(ctx, audioKey)
		}
		if err == internal.ErrCondition {
			if userSlug != "" {
				return internal.Error(409, "slug already taken"), nil
			}
			continue
		}
		return internal.Error(500, "internal error"), nil
	}

	return internal.Error(500, "slug collision retries exhausted"), nil
}
