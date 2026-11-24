// Package consent implements the ARC-allocated Go consent service core
// (TECH-18): the FR-29 consent state machine, the append-only ledger
// discipline (FR-35), and the closure masking rules (FR-32/FR-34) plus the
// offer/conversation lifecycle constants — ported 1:1 from the Postgres
// trigger and the TS edge so both implementations are held to the same
// behaviour.
package consent

// State is the FR-29 consent state machine:
// DETECTED → NUDGED → EXPRESSED → MUTUAL → OPEN.
type State string

const (
	Detected  State = "DETECTED"
	Nudged    State = "NUDGED"
	Expressed State = "EXPRESSED"
	Mutual    State = "MUTUAL"
	Open      State = "OPEN"
)

// ConsentTransitionOK — FR-29: exact port of consent_transition_ok() in
// db/migrations/0001_init.sql. A nil from-state models SQL NULL (a pair that
// does not exist yet): only DETECTED is legal. The database trigger remains
// the final arbiter at write time; this helper lets the service compute
// intent without a round trip.
func ConsentTransitionOK(from *State, to State) bool {
	if from == nil {
		return to == Detected
	}
	switch *from {
	case Detected:
		return to == Nudged || to == Expressed
	case Nudged:
		return to == Expressed
	case Expressed:
		return to == Mutual // both sides expressed
	case Mutual:
		return to == Open
	default:
		return false
	}
}
