package internal

import "context"

// FanoutPush is a stub for future Web Push fan-out (VAPID + payload-less
// POST to each SUB# endpoint). For backend M1-M3 this is a no-op so
// rally_compose can call it without being rewritten when push lands.
// We exercise QuerySubs to keep the code path warm and catch IAM drift
// on the rally_compose IAM role before the feature ships.
func (s *Store) FanoutPush(ctx context.Context, slug string) error {
	// TODO(push): replace with actual Web Push VAPID dispatch.
	_, _ = s.QuerySubs(ctx, slug)
	return nil
}
