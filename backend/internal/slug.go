package internal

import (
	"fmt"
	"regexp"
	"strings"
)

// Slug grammar per SPEC §Slug canonicalization:
//
//	[a-z0-9-]{3,32}, no leading or trailing hyphen, lowercase only.
//
// Router, DDB PK, and S3 key prefix all use the same canonical string —
// no case folding, percent-decoding, or Unicode normalization applied
// anywhere downstream of request parse.
var slugPattern = regexp.MustCompile(`^[a-z0-9-]{3,32}$`)

// Canonicalize validates the slug and returns it verbatim on success.
// The only canonicalization operation permitted by SPEC is "reject
// anything that does not already match the grammar." Whitespace,
// mixed case, and percent-encoded bytes all fail validation — they
// are not silently normalized.
func Canonicalize(s string) (string, error) {
	if !Validate(s) {
		return "", fmt.Errorf("invalid slug")
	}
	return s, nil
}

// Validate reports whether s matches the slug grammar. It rejects
// empty strings, strings outside the 3..32 length range, any
// character outside [a-z0-9-], and leading/trailing hyphens.
func Validate(s string) bool {
	if !slugPattern.MatchString(s) {
		return false
	}
	if strings.HasPrefix(s, "-") || strings.HasSuffix(s, "-") {
		return false
	}
	return true
}
