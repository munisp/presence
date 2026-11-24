package presence

import "time"

// FR-28: density-scaled match budget. The denser the venue, the fewer scans
// each account may burn per window — from three per hour in a sparse cell
// down to one per day in a crowd. This is a product budget, separate from
// the SEC-20 anti-abuse ceilings (200 scans/hour), which still apply.
// Mirrors services/edge/src/budget.ts.

// BudgetBand names the three rungs of the FR-28 ladder.
type BudgetBand string

const (
	BandSparse BudgetBand = "sparse"
	BandBusy   BudgetBand = "busy"
	BandCrowd  BudgetBand = "crowd"
)

// MatchBudget is the per-account scan allowance for one cell population.
type MatchBudget struct {
	Band   BudgetBand
	Limit  int           // scans allowed per window
	Window time.Duration // window length
}

const (
	BudgetBusyMinPop  = 25  // below → sparse
	BudgetCrowdMinPop = 100 // at/above → crowd
)

// MatchBudgetFor returns the FR-28 budget for a cell population, per the spec
// ladder.
func MatchBudgetFor(cellPopulation int) MatchBudget {
	if cellPopulation >= BudgetCrowdMinPop {
		return MatchBudget{Band: BandCrowd, Limit: 1, Window: 86_400 * time.Second}
	}
	if cellPopulation >= BudgetBusyMinPop {
		return MatchBudget{Band: BandBusy, Limit: 2, Window: 3_600 * time.Second}
	}
	return MatchBudget{Band: BandSparse, Limit: 3, Window: 3_600 * time.Second}
}
