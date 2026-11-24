package venue

import "testing"

func TestKSuppressed(t *testing.T) {
	// BR-13: below k the value is withheld entirely.
	if got := KSuppressed(10, KMin); got != nil {
		t.Errorf("10 below k=11: got %v, want nil", *got)
	}
	if got := KSuppressed(0, KMin); got != nil {
		t.Errorf("0: got %v, want nil", *got)
	}
	if got := KSuppressed(11, KMin); got == nil || *got != 11 {
		t.Errorf("11 at k: got %v, want 11", got)
	}
	if got := KSuppressed(10_000, KMin); got == nil || *got != 10_000 {
		t.Errorf("10000: got %v, want 10000", got)
	}
	// The floor itself is pinned to the TS constant.
	if KMin != 11 {
		t.Errorf("KMin = %d, want 11", KMin)
	}
}

func TestBuildDashboard(t *testing.T) {
	out := BuildDashboard(DashboardInput{
		LivePresence:      10, // suppressed
		ScansLastHour:     11, // served
		ActiveOffers:      0,  // suppressed
		LiveAnnouncements: 42,
		LiveEventPresence: 7, // suppressed
	})
	if out.K != KMin {
		t.Errorf("K = %d, want %d", out.K, KMin)
	}
	if out.LivePresence != nil {
		t.Errorf("LivePresence should be suppressed, got %v", *out.LivePresence)
	}
	if out.ScansLastHour == nil || *out.ScansLastHour != 11 {
		t.Errorf("ScansLastHour got %v, want 11", out.ScansLastHour)
	}
	if out.ActiveOffers != nil {
		t.Errorf("ActiveOffers should be suppressed, got %v", *out.ActiveOffers)
	}
	if out.LiveAnnouncements == nil || *out.LiveAnnouncements != 42 {
		t.Errorf("LiveAnnouncements got %v, want 42", out.LiveAnnouncements)
	}
	if out.LiveEventPresence != nil {
		t.Errorf("LiveEventPresence should be suppressed, got %v", *out.LiveEventPresence)
	}
}
