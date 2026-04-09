package internal

import (
	"encoding/base64"
	"fmt"
	"strings"
)

// MaxAudioBytes is the decoded ceiling per SPEC §HTTP API wire limits:
//
//	audio_b64 decoded ≤ 512 KB. Opus @ 32 kbps × 2 min ≈ 480 KB.
const MaxAudioBytes = 512 * 1024

// AllowedAudioMIMEs per SPEC §HTTP API wire limits. Anything else → 400.
var AllowedAudioMIMEs = []string{
	"audio/ogg; codecs=opus",
	"audio/webm; codecs=opus",
}

// DecodeAndValidate decodes a base64-encoded audio blob and enforces
// the size ceiling. Accepts standard base64 with optional padding.
// Returns the raw bytes or an error.
func DecodeAndValidate(b64 string) ([]byte, error) {
	b64 = strings.TrimSpace(b64)
	if b64 == "" {
		return nil, fmt.Errorf("empty audio_b64")
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		// Try unpadded std encoding (clients sometimes strip padding).
		raw, err = base64.RawStdEncoding.DecodeString(b64)
		if err != nil {
			return nil, fmt.Errorf("invalid base64: %w", err)
		}
	}
	if len(raw) > MaxAudioBytes {
		return nil, fmt.Errorf("audio exceeds %d bytes", MaxAudioBytes)
	}
	return raw, nil
}

// ValidateAudioMIME returns true if m is one of the allowed MIME types.
func ValidateAudioMIME(m string) bool {
	m = strings.TrimSpace(m)
	for _, allowed := range AllowedAudioMIMEs {
		if m == allowed {
			return true
		}
	}
	return false
}
