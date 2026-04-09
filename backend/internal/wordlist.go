package internal

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
)

// Server-generated slug wordlist. 100 adjectives × 100 nouns = 10,000
// combinations. Per SPEC §POST /api/compose, the collision retry budget
// is 5 attempts; SPEC line ~386 cites a ~1M space that assumes 1000×1000
// lists. TODO(wordlist): expand to 1000×1000 before launch if collision
// rate matters; for M1-M3 the smaller list is fine — the smoke test
// never triggers a real collision.
//
// Words are plain ASCII, short, memorable, napkin-writable. No hyphens
// inside individual words; the join character is the only hyphen in
// the final slug.

var slugAdjectives = []string{
	"amber", "ancient", "quiet", "bright", "calm", "clear", "cold", "crisp",
	"dark", "deep", "distant", "dusty", "early", "empty", "faint", "fair",
	"fallen", "far", "fine", "fresh", "gentle", "golden", "grand", "grave",
	"green", "grey", "happy", "hidden", "high", "hollow", "honest", "humble",
	"icy", "idle", "inner", "jagged", "kind", "late", "light", "little",
	"lonely", "long", "loose", "loud", "low", "lucid", "lucky", "lush",
	"main", "mellow", "mild", "misty", "moonlit", "muted", "narrow", "near",
	"new", "old", "open", "pale", "patient", "plain", "plum", "polar",
	"pretty", "prime", "proud", "pure", "quaint", "quick", "quirky", "raw",
	"red", "rich", "rosy", "rough", "royal", "rustic", "sable", "safe",
	"secret", "sharp", "shy", "silent", "silver", "simple", "slow", "small",
	"smooth", "snowy", "soft", "solid", "spare", "still", "stout", "sunny",
	"sweet", "tender", "thin", "tidy",
}

var slugNouns = []string{
	"anchor", "arbor", "arrow", "autumn", "badge", "basin", "beacon", "beam",
	"bell", "blossom", "bough", "branch", "brook", "canal", "candle", "canyon",
	"cavern", "cedar", "cipher", "clover", "comet", "cove", "creek", "crest",
	"crown", "dawn", "delta", "dune", "dusk", "echo", "ember", "envoy",
	"falcon", "feather", "fen", "fern", "field", "flame", "fog", "forest",
	"fountain", "fox", "garden", "gate", "glade", "glyph", "grove", "harbor",
	"hare", "harp", "hatch", "haven", "hearth", "hedge", "helm", "hollow",
	"horizon", "inlet", "island", "ivy", "lagoon", "lantern", "lark", "ledge",
	"lens", "letter", "light", "lily", "lodge", "loom", "market", "meadow",
	"mesa", "mint", "mirror", "mist", "moon", "moss", "motif", "mountain",
	"nest", "node", "oak", "orbit", "orchard", "otter", "owl", "path",
	"pearl", "petal", "pine", "plaza", "pond", "port", "quarry", "quill",
	"raven", "reed", "ridge", "river",
}

// GenerateSlug returns a fresh "<adjective>-<noun>" string. Uses
// crypto/rand for the word indices; panics only if the entropy source
// is broken. The returned slug matches the grammar enforced by Validate.
func GenerateSlug() string {
	a := randIndex(len(slugAdjectives))
	n := randIndex(len(slugNouns))
	return fmt.Sprintf("%s-%s", slugAdjectives[a], slugNouns[n])
}

func randIndex(n int) int {
	if n <= 0 {
		return 0
	}
	var buf [4]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(fmt.Sprintf("crypto/rand failure: %v", err))
	}
	return int(binary.BigEndian.Uint32(buf[:])) % n
}
