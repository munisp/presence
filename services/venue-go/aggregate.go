// Package venue implements the ARC-allocated Go venue service core
// (TECH-18): the pure domain logic of the venue registry and dashboard —
// BR-13 k-anonymity suppression, the FR-42 operating-schedule shape and
// evaluation, the partner-status lifecycle (FR-42/BR-14), and the aggregate
// dashboard figures (BR-12). Ported 1:1 from the TS edge and the Postgres
// constraints so both implementations are held to the same behaviour.
package venue

// KMin — BR-13: k-anonymity floor for every aggregate figure. Mirrors
// services/edge/src/aggregate.ts.
const KMin = 11

// KSuppressed applies k-anonymity suppression: when fewer than k individuals
// stand behind a number, the value is withheld entirely (nil) — the venue
// sees "suppressed", never the small number.
func KSuppressed(value, k int) *int {
	if value >= k {
		v := value
		return &v
	}
	return nil
}
