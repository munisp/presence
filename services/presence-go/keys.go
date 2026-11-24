package presence

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

// Canonical Valkey key model, ported 1:1 from services/edge/src/context.ts
// and services/edge/src/lifecycle.ts. Both sides of a relationship must hash
// to the same key, so pair ids are canonically ordered before formatting.

// canonicalPair orders two ids so either side computes the same key.
func canonicalPair(a, b string) (lo, hi string) {
	if a < b {
		return a, b
	}
	return b, a
}

// SuppressionKey — FR-23: canonical pair ordering, ten-minute TTL.
func SuppressionKey(a, b string) string {
	lo, hi := canonicalPair(a, b)
	return "suppress:" + lo + ":" + hi
}

// SuppressionTTL — FR-23.
const SuppressionTTL = 600 * time.Second

// RotationKey — FR-91: canonical pair ordering, seven-day TTL. Set when a
// pair's offer is acted on (consent express); the scan excludes rotating
// pairs so a declined/expired offer is not re-served for a week.
func RotationKey(a, b string) string {
	lo, hi := canonicalPair(a, b)
	return "rotate:" + lo + ":" + hi
}

// RotationTTL — FR-91: seven days.
const RotationTTL = 604_800 * time.Second

// BlockKey — FR-34: canonical ordering, permanent (no TTL, unlike FR-23).
func BlockKey(a, b string) string {
	lo, hi := canonicalPair(a, b)
	return "block:" + lo + ":" + hi
}

// NewPresenceSessionID — FR-16: opaque per-presence-session identifier
// (128-bit random, hex). The session id — not the account id — is what a scan
// hands to candidates pre-OPEN, so the wire never exposes a stable account
// identifier before mutual consent.
func NewPresenceSessionID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// SessionKey — reverse index: presence session id -> account id (FR-16).
func SessionKey(sessionID string) string {
	return "presence:session:" + sessionID
}
