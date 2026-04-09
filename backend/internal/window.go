package internal

import "time"

// SPEC §Reply window — time spans.
//
// RESPONSE_FUSE  (5:00) — UI countdown from the moment of listen.
// RECORD_TIMER   (2:00) — audio recording ceiling.
// SUBMIT_DEADLINE = RESPONSE_FUSE + RECORD_TIMER = 7:00 — wall-clock
// deadline the server enforces via reply_code_exp on META.
const (
	ResponseFuse    = 5 * time.Minute
	RecordTimer     = 2 * time.Minute
	SubmitDeadline  = ResponseFuse + RecordTimer
	SlugTTLDuration = 7 * 24 * time.Hour

	// SubCap is the per-slug Web Push subscription plurality cap.
	// Subscribes past this evict the oldest by added_at.
	SubCap = 4
)

// ClampReplyExp returns reply_code_exp per SPEC §Reply window:
//
//	reply_code_exp = min(listen_time + SUBMIT_DEADLINE, slug.expires_at)
//
// Both arguments are epoch seconds; the return is epoch seconds.
// The clamp ensures the reply window cannot outlive the slug itself.
func ClampReplyExp(listenUnix, slugExpiresAt int64) int64 {
	deadline := listenUnix + int64(SubmitDeadline.Seconds())
	if slugExpiresAt > 0 && deadline > slugExpiresAt {
		return slugExpiresAt
	}
	return deadline
}
