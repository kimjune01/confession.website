package internal

import (
	"crypto/rand"
	"fmt"
	"strings"
)

// Crockford base32: 0-9 and A-Z minus I L O U. 32 symbols, 5 bits each.
// Four characters = 20 bits ≈ 1M possible codes. See SPEC §Reply code format.
const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// GenerateReplyCode returns a fresh 4-character crockford base32 code.
// Uses crypto/rand; panics only if the entropy source is broken.
func GenerateReplyCode() string {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("crypto/rand failure: %v", err))
	}
	out := make([]byte, 4)
	for i, b := range buf {
		out[i] = crockfordAlphabet[int(b)%32]
	}
	return string(out)
}

// NormalizeReplyCode uppercases the input and strips internal dashes
// and whitespace. Returns the canonical form and whether it is a
// valid 4-char crockford base32 string. See SPEC §HTTP API wire limits.
func NormalizeReplyCode(s string) (string, bool) {
	s = strings.ToUpper(s)
	s = strings.ReplaceAll(s, "-", "")
	s = strings.Join(strings.Fields(s), "")
	if len(s) != 4 {
		return "", false
	}
	for i := 0; i < 4; i++ {
		if !strings.ContainsRune(crockfordAlphabet, rune(s[i])) {
			return "", false
		}
	}
	return s, true
}
