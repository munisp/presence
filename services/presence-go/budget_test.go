package presence

import (
	"testing"
	"time"
)

func TestMatchBudgetFor(t *testing.T) {
	// FR-28 ladder, pinned to services/edge/src/budget.ts.
	cases := []struct {
		pop        int
		wantBand   BudgetBand
		wantLimit  int
		wantWindow time.Duration
	}{
		{0, BandSparse, 3, 3_600 * time.Second},
		{1, BandSparse, 3, 3_600 * time.Second},
		{24, BandSparse, 3, 3_600 * time.Second},
		{25, BandBusy, 2, 3_600 * time.Second},
		{99, BandBusy, 2, 3_600 * time.Second},
		{100, BandCrowd, 1, 86_400 * time.Second},
		{10_000, BandCrowd, 1, 86_400 * time.Second},
	}
	for _, c := range cases {
		got := MatchBudgetFor(c.pop)
		if got.Band != c.wantBand || got.Limit != c.wantLimit || got.Window != c.wantWindow {
			t.Errorf("pop %d: got %+v want band=%s limit=%d window=%v",
				c.pop, got, c.wantBand, c.wantLimit, c.wantWindow)
		}
	}
	if BudgetBusyMinPop != 25 || BudgetCrowdMinPop != 100 {
		t.Errorf("ladder thresholds drifted: busy=%d crowd=%d", BudgetBusyMinPop, BudgetCrowdMinPop)
	}
}
