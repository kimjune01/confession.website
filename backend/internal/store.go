// Pattern from ephemeral.website/backend/internal/store.go
// as of commit aa37e846ecfb38efddba75ffc28707bfbd0a004d.
// Adapted for confession's single-META data model: one table,
// one item per slug, flipped in place between pending and
// burned-empty. No Token/Session types — the state machine
// lives on META itself.
package internal

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// ErrCondition is returned when a DDB conditional expression fails.
// Handlers distinguish this from real errors to decide between 404,
// "burn race loser", etc.
var ErrCondition = errors.New("conditional check failed")

// ErrNotFound is returned when a GetItem finds nothing (or when the
// item exists but is past expires_at).
var ErrNotFound = errors.New("not found")

// Meta is the single per-slug item. Field names on the wire (JSON and
// DDB) match SPEC §Data model exactly. The audio MIME type is not
// persisted on META — it is set on the S3 object's Content-Type header
// at upload and read back by the listen Lambda from the GetObject
// response, consistent with SPEC §Data model's explicit field list.
type Meta struct {
	PK             string `dynamodbav:"PK"`
	SK             string `dynamodbav:"SK"`
	TailSeq        int    `dynamodbav:"tail_seq"`
	TailBurned     bool   `dynamodbav:"tail_burned"`
	Terminal       bool   `dynamodbav:"terminal"`
	TailAudioS3Key string `dynamodbav:"tail_audio_s3_key,omitempty"`
	TailText       string `dynamodbav:"tail_text,omitempty"`
	ReplyCode      string `dynamodbav:"reply_code,omitempty"`
	ReplyCodeExp   int64  `dynamodbav:"reply_code_exp,omitempty"`
	CreatedAt      string `dynamodbav:"created_at"`
	ExpiresAt      int64  `dynamodbav:"expires_at"`
}

// Sub is a per-endpoint Web Push subscription. Plural per slug, capped
// at N=4 (see SPEC §SUB). SK is deterministic from endpoint.
type Sub struct {
	PK        string `dynamodbav:"PK"`
	SK        string `dynamodbav:"SK"`
	Endpoint  string `dynamodbav:"endpoint"`
	P256dh    string `dynamodbav:"p256dh"`
	Auth      string `dynamodbav:"auth"`
	AddedAt   string `dynamodbav:"added_at"`
	ExpiresAt int64  `dynamodbav:"expires_at"`
}

// Store holds the AWS clients and resource names. One table, one bucket.
type Store struct {
	DDB         *dynamodb.Client
	S3          *s3.Client
	MetaTable   string
	AudioBucket string
	// PushClient is reused across all Web Push fan-outs. A single
	// http.Client is goroutine-safe and pools connections per push
	// service origin, so repeated pushes to the same browser vendor's
	// endpoint reuse warmed TLS sessions.
	PushClient *http.Client
}

// NewStore initializes the Store from default AWS credentials and the
// META_TABLE / AUDIO_BUCKET environment variables. An optional
// DDB_ENDPOINT env var points at local DynamoDB for smoke tests.
func NewStore(ctx context.Context) (*Store, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, err
	}

	ddbOpts := []func(*dynamodb.Options){}
	if ep := os.Getenv("DDB_ENDPOINT"); ep != "" {
		ddbOpts = append(ddbOpts, func(o *dynamodb.Options) {
			o.BaseEndpoint = aws.String(ep)
		})
	}

	s3Opts := []func(*s3.Options){}
	if ep := os.Getenv("S3_ENDPOINT"); ep != "" {
		s3Opts = append(s3Opts, func(o *s3.Options) {
			o.BaseEndpoint = aws.String(ep)
			o.UsePathStyle = true
		})
	}

	return &Store{
		DDB:         dynamodb.NewFromConfig(cfg, ddbOpts...),
		S3:          s3.NewFromConfig(cfg, s3Opts...),
		MetaTable:   os.Getenv("META_TABLE"),
		AudioBucket: os.Getenv("AUDIO_BUCKET"),
		PushClient: &http.Client{
			// Per-request budget is enforced by context in FanoutPush,
			// but the client-level timeout is a belt-and-braces cap on
			// any single send in case the context is misused.
			Timeout: 2 * time.Second,
		},
	}, nil
}

// MetaPK returns the canonical partition key for a slug.
func MetaPK(slug string) string { return "slug#" + slug }

// SubSK returns the canonical sort key for a Web Push endpoint.
// "SUB#" + first 8 hex chars of sha256(endpoint). Deterministic so
// repeat subscribes from the same endpoint collapse to one item.
func SubSK(endpoint string) string {
	h := sha256.Sum256([]byte(endpoint))
	return "SUB#" + hex.EncodeToString(h[:])[:8]
}

// ----- META operations ------------------------------------------------

// PutMeta creates the META item for a fresh slug. Conditional on
// attribute_not_exists(PK) — collision → ErrCondition.
func (s *Store) PutMeta(ctx context.Context, m Meta) error {
	item, err := attributevalue.MarshalMap(m)
	if err != nil {
		return err
	}
	_, err = s.DDB.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           &s.MetaTable,
		Item:                item,
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	})
	if err != nil {
		if isConditionalCheckFailed(err) {
			return ErrCondition
		}
		return err
	}
	return nil
}

// GetMeta reads the META item for slug. Returns ErrNotFound if the
// item is absent or past expires_at. Handlers should treat both as 404.
func (s *Store) GetMeta(ctx context.Context, slug string) (Meta, error) {
	out, err := s.DDB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: &s.MetaTable,
		Key: map[string]ddbtypes.AttributeValue{
			"PK": &ddbtypes.AttributeValueMemberS{Value: MetaPK(slug)},
			"SK": &ddbtypes.AttributeValueMemberS{Value: "META"},
		},
	})
	if err != nil {
		return Meta{}, err
	}
	if out.Item == nil {
		return Meta{}, ErrNotFound
	}
	var m Meta
	if err := attributevalue.UnmarshalMap(out.Item, &m); err != nil {
		return Meta{}, err
	}
	if m.ExpiresAt <= Now().Unix() {
		return Meta{}, ErrNotFound
	}
	return m, nil
}

// UpdateMetaBurn flips the META from pending to burned-empty. The
// condition enforces tail_seq match, tail not already burned, and
// not expired. When terminal is false, the SET clause also mints
// reply_code and reply_code_exp so the recipient can rally-compose.
// When terminal is true (text-only consume), no reply code is set —
// the channel is closed.
//
// Callers pass freshCode and freshCodeExp they already generated;
// the store stays oblivious to business semantics.
func (s *Store) UpdateMetaBurn(ctx context.Context, slug string, expectedSeq int, terminal bool, freshCode string, freshCodeExp int64) error {
	now := Now().Unix()

	set := []string{"tail_burned = :true", "terminal = :term"}
	remove := []string{"tail_audio_s3_key", "tail_text"}

	values := map[string]ddbtypes.AttributeValue{
		":seq":   &ddbtypes.AttributeValueMemberN{Value: fmt.Sprintf("%d", expectedSeq)},
		":true":  &ddbtypes.AttributeValueMemberBOOL{Value: true},
		":false": &ddbtypes.AttributeValueMemberBOOL{Value: false},
		":term":  &ddbtypes.AttributeValueMemberBOOL{Value: terminal},
		":now":   &ddbtypes.AttributeValueMemberN{Value: fmt.Sprintf("%d", now)},
	}

	if !terminal {
		set = append(set, "reply_code = :rc", "reply_code_exp = :rce")
		values[":rc"] = &ddbtypes.AttributeValueMemberS{Value: freshCode}
		values[":rce"] = &ddbtypes.AttributeValueMemberN{Value: fmt.Sprintf("%d", freshCodeExp)}
	}

	update := "SET " + strings.Join(set, ", ") + " REMOVE " + strings.Join(remove, ", ")

	_, err := s.DDB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &s.MetaTable,
		Key: map[string]ddbtypes.AttributeValue{
			"PK": &ddbtypes.AttributeValueMemberS{Value: MetaPK(slug)},
			"SK": &ddbtypes.AttributeValueMemberS{Value: "META"},
		},
		UpdateExpression:          aws.String(update),
		ConditionExpression:       aws.String("tail_seq = :seq AND tail_burned = :false AND expires_at > :now"),
		ExpressionAttributeValues: values,
	})
	if err != nil {
		if isConditionalCheckFailed(err) {
			return ErrCondition
		}
		return err
	}
	return nil
}

// UpdateMetaCompose flips the META from burned-empty back to pending
// (rally-compose). The condition gates on reply_code equality, which
// is the whole capability check per SPEC §Atomicity contracts. Success
// increments tail_seq and REMOVEs reply_code / reply_code_exp so a
// replay naturally fails.
//
// requestNow is the request-receipt time (epoch seconds) captured by
// the handler BEFORE any upload work. SPEC §Reply window says expiry
// is judged at request receipt, not post-upload-processing, so a slow
// S3 upload doesn't penalize a user who submitted in time.
func (s *Store) UpdateMetaCompose(ctx context.Context, slug string, requestNow int64, requestCode, newAudioKey, newText string) error {
	now := requestNow

	set := []string{
		"tail_seq = tail_seq + :one",
		"tail_burned = :false",
	}
	values := map[string]ddbtypes.AttributeValue{
		":rc":    &ddbtypes.AttributeValueMemberS{Value: requestCode},
		":now":   &ddbtypes.AttributeValueMemberN{Value: fmt.Sprintf("%d", now)},
		":false": &ddbtypes.AttributeValueMemberBOOL{Value: false},
		":one":   &ddbtypes.AttributeValueMemberN{Value: "1"},
	}
	if newAudioKey != "" {
		set = append(set, "tail_audio_s3_key = :ak")
		values[":ak"] = &ddbtypes.AttributeValueMemberS{Value: newAudioKey}
	}
	if newText != "" {
		set = append(set, "tail_text = :tt")
		values[":tt"] = &ddbtypes.AttributeValueMemberS{Value: newText}
	}

	// If the new compose is text-only, explicitly REMOVE any stale
	// audio field alongside the reply code. If audio-only, remove
	// stale text. This keeps the burned-empty → pending flip clean.
	remove := []string{"reply_code", "reply_code_exp"}
	if newAudioKey == "" {
		remove = append(remove, "tail_audio_s3_key")
	}
	if newText == "" {
		remove = append(remove, "tail_text")
	}

	update := "SET " + strings.Join(set, ", ") + " REMOVE " + strings.Join(remove, ", ")

	_, err := s.DDB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &s.MetaTable,
		Key: map[string]ddbtypes.AttributeValue{
			"PK": &ddbtypes.AttributeValueMemberS{Value: MetaPK(slug)},
			"SK": &ddbtypes.AttributeValueMemberS{Value: "META"},
		},
		UpdateExpression:          aws.String(update),
		ConditionExpression:       aws.String("reply_code = :rc AND reply_code_exp > :now AND tail_burned = :true AND terminal = :false AND expires_at > :now"),
		ExpressionAttributeValues: mergeValues(values, map[string]ddbtypes.AttributeValue{":true": &ddbtypes.AttributeValueMemberBOOL{Value: true}}),
	})
	if err != nil {
		if isConditionalCheckFailed(err) {
			return ErrCondition
		}
		return err
	}
	return nil
}

// ----- SUB operations -------------------------------------------------

// PutSub writes a single SUB# item iff one does not already exist at
// (PK, SK). Repeat subscribes from the same endpoint collapse to a
// no-op — `added_at` is preserved, and eviction order stays stable.
// Returns ErrCondition on duplicate; callers treat it as success.
func (s *Store) PutSub(ctx context.Context, sub Sub) error {
	item, err := attributevalue.MarshalMap(sub)
	if err != nil {
		return err
	}
	_, err = s.DDB.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           &s.MetaTable,
		Item:                item,
		ConditionExpression: aws.String("attribute_not_exists(SK)"),
	})
	if err != nil {
		if isConditionalCheckFailed(err) {
			return ErrCondition
		}
		return err
	}
	return nil
}

// QuerySubs returns all SUB# items for a slug, ordered by SK.
func (s *Store) QuerySubs(ctx context.Context, slug string) ([]Sub, error) {
	out, err := s.DDB.Query(ctx, &dynamodb.QueryInput{
		TableName:              &s.MetaTable,
		KeyConditionExpression: aws.String("PK = :pk AND begins_with(SK, :sub)"),
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":pk":  &ddbtypes.AttributeValueMemberS{Value: MetaPK(slug)},
			":sub": &ddbtypes.AttributeValueMemberS{Value: "SUB#"},
		},
	})
	if err != nil {
		return nil, err
	}
	subs := make([]Sub, 0, len(out.Items))
	for _, item := range out.Items {
		var sub Sub
		if err := attributevalue.UnmarshalMap(item, &sub); err != nil {
			return nil, err
		}
		subs = append(subs, sub)
	}
	return subs, nil
}

// DeleteSub removes a single SUB# item by its primary key. Called by
// FanoutPush when the push service returns 404 or 410 (subscription
// is permanently gone and should be cleaned up).
func (s *Store) DeleteSub(ctx context.Context, pk, sk string) error {
	_, err := s.DDB.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: &s.MetaTable,
		Key: map[string]ddbtypes.AttributeValue{
			"PK": &ddbtypes.AttributeValueMemberS{Value: pk},
			"SK": &ddbtypes.AttributeValueMemberS{Value: sk},
		},
	})
	return err
}

// EvictOldestSub deletes the SUB# item with the earliest added_at.
// Called by subscribe when the per-slug plurality cap (N=4) is hit.
func (s *Store) EvictOldestSub(ctx context.Context, slug string) error {
	subs, err := s.QuerySubs(ctx, slug)
	if err != nil {
		return err
	}
	if len(subs) == 0 {
		return nil
	}
	sort.Slice(subs, func(i, j int) bool { return subs[i].AddedAt < subs[j].AddedAt })
	oldest := subs[0]
	_, err = s.DDB.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: &s.MetaTable,
		Key: map[string]ddbtypes.AttributeValue{
			"PK": &ddbtypes.AttributeValueMemberS{Value: oldest.PK},
			"SK": &ddbtypes.AttributeValueMemberS{Value: oldest.SK},
		},
	})
	return err
}

// ----- S3 operations --------------------------------------------------

// UploadAudio puts a raw audio blob at the given key. ContentType
// must be one of SPEC's allowed MIME types; caller validates.
func (s *Store) UploadAudio(ctx context.Context, key string, data []byte, contentType string) error {
	_, err := s.S3.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      &s.AudioBucket,
		Key:         &key,
		Body:        bytes.NewReader(data),
		ContentType: &contentType,
	})
	return err
}

// GetAudio reads a raw audio blob from S3. Returns bytes and the
// ContentType header (which the listen handler echoes back to the
// client as audio_mime).
func (s *Store) GetAudio(ctx context.Context, key string) ([]byte, string, error) {
	out, err := s.S3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: &s.AudioBucket,
		Key:    &key,
	})
	if err != nil {
		var nsk *s3types.NoSuchKey
		if errors.As(err, &nsk) {
			return nil, "", ErrNotFound
		}
		return nil, "", err
	}
	defer out.Body.Close()
	data, err := io.ReadAll(out.Body)
	if err != nil {
		return nil, "", err
	}
	mime := ""
	if out.ContentType != nil {
		mime = *out.ContentType
	}
	return data, mime, nil
}

// DeleteAudio removes the S3 object. NoSuchKey is swallowed so the
// listen path can call this idempotently after a burn-race win.
func (s *Store) DeleteAudio(ctx context.Context, key string) error {
	_, err := s.S3.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: &s.AudioBucket,
		Key:    &key,
	})
	if err != nil {
		var nsk *s3types.NoSuchKey
		if errors.As(err, &nsk) {
			return nil
		}
		return err
	}
	return nil
}

// ----- helpers --------------------------------------------------------

func isConditionalCheckFailed(err error) bool {
	var ccfe *ddbtypes.ConditionalCheckFailedException
	return errors.As(err, &ccfe)
}

func mergeValues(a, b map[string]ddbtypes.AttributeValue) map[string]ddbtypes.AttributeValue {
	out := make(map[string]ddbtypes.AttributeValue, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

// IncrementDailyCount atomically bumps the confession counter for
// today. PK = "stats", SK = "YYYY-MM-DD". No user data, no slug,
// no content — just a number.
func (s *Store) IncrementDailyCount(ctx context.Context) {
	today := Now().Format("2006-01-02")
	_, _ = s.DDB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &s.MetaTable,
		Key: map[string]ddbtypes.AttributeValue{
			"PK": &ddbtypes.AttributeValueMemberS{Value: "stats"},
			"SK": &ddbtypes.AttributeValueMemberS{Value: today},
		},
		UpdateExpression: aws.String("ADD #c :one"),
		ExpressionAttributeNames: map[string]string{
			"#c": "count",
		},
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":one": &ddbtypes.AttributeValueMemberN{Value: "1"},
		},
	})
}

// NewAudioKey returns a fresh S3 key for an audio blob on a slug.
// Format: audio/<slug>/<hex>.opus. The 16-hex nonce prevents key
// collision within a single slug's lifetime.
func NewAudioKey(slug string) string {
	var buf [8]byte
	if _, err := readRand(buf[:]); err != nil {
		panic(fmt.Sprintf("crypto/rand failure: %v", err))
	}
	return fmt.Sprintf("audio/%s/%s.opus", slug, hex.EncodeToString(buf[:]))
}

// indirection so tests can swap entropy.
var readRand = func(p []byte) (int, error) {
	return rand.Read(p)
}

// Clock helper for ISO8601 timestamps.
func IsoNow() string { return Now().UTC().Format(time.RFC3339) }
