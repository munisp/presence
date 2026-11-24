package consent

import "time"

// Offer lifecycle constants, pinned to services/edge/src/lifecycle.ts.
const (
	OfferTTL        = 30 * time.Minute // FR-33: offers expire after the last action
	ConversationTTL = 24 * time.Hour   // FR-37: conversations close unless both keep
	PurgeAfterClose = 24 * time.Hour   // NFR-20: closed rows purge after 24 h
	LifecycleTick   = time.Minute      // lifecycle sweep cadence
)

// CloseReason is the internal reason a pair closed (FR-32/FR-34 govern what
// the counterpart may learn).
type CloseReason string

const (
	ReasonExpired  CloseReason = "expired"
	ReasonDeclined CloseReason = "declined"
	ReasonBlocked  CloseReason = "blocked"
	ReasonLapsed   CloseReason = "lapsed"
)

// MaskCloseReason — FR-32: silent decline (a 'declined' close is reported as
// 'expired'); FR-34: blocks are invisible (nil — the row never reaches the
// list at all). Exact port of maskCloseReason() in lifecycle.ts.
func MaskCloseReason(reason CloseReason) *CloseReason {
	switch reason {
	case ReasonBlocked:
		return nil
	case ReasonDeclined:
		masked := ReasonExpired
		return &masked
	default:
		return &reason
	}
}

// IsOfferLive — FR-33: an offer is live while it is pre-OPEN, unclosed, and
// inside its deadline. Exact port of isOfferLive() in lifecycle.ts.
func IsOfferLive(state State, closedAt, expiresAt *time.Time, now time.Time) bool {
	return state != Open && closedAt == nil && (expiresAt == nil || expiresAt.After(now))
}
