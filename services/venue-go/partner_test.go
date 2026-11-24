package venue

import (
	"testing"
	"time"
)

func TestValidPartnerStatus(t *testing.T) {
	// The set is pinned to the CHECK constraint in migration 0020.
	for _, s := range []PartnerStatus{StatusProspect, StatusActive, StatusSuspended, StatusOffboarded} {
		if !ValidPartnerStatus(s) {
			t.Errorf("%q should be valid", s)
		}
	}
	for _, s := range []PartnerStatus{"", "Active", "pending", "deleted"} {
		if ValidPartnerStatus(s) {
			t.Errorf("%q should be invalid", s)
		}
	}
}

func TestSyncActive(t *testing.T) {
	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	stamp := now.Add(-time.Hour)

	// Active is derived — live exactly when the status is 'active'.
	cases := []struct {
		name       string
		new, old   PartnerStatus
		oldStamp   *time.Time
		wantActive bool
		wantStamp  *time.Time
	}{
		{"prospect goes live", StatusActive, StatusProspect, nil, true, nil},
		{"active stays active", StatusActive, StatusActive, nil, true, nil},
		{"suspend from active", StatusSuspended, StatusActive, nil, false, &now},
		{"stay suspended keeps stamp", StatusSuspended, StatusSuspended, &stamp, false, &stamp},
		{"resume clears stamp", StatusActive, StatusSuspended, &stamp, true, nil},
		{"offboard clears stamp", StatusOffboarded, StatusSuspended, &stamp, false, nil},
		{"prospect is not live", StatusProspect, StatusProspect, nil, false, nil},
		{"offboarded is not live", StatusOffboarded, StatusActive, nil, false, nil},
	}
	for _, c := range cases {
		active, suspendedAt := SyncActive(c.new, c.old, c.oldStamp, now)
		if active != c.wantActive {
			t.Errorf("%s: active got %v want %v", c.name, active, c.wantActive)
		}
		switch {
		case c.wantStamp == nil && suspendedAt != nil:
			t.Errorf("%s: suspendedAt got %v want nil", c.name, *suspendedAt)
		case c.wantStamp != nil && suspendedAt == nil:
			t.Errorf("%s: suspendedAt got nil want %v", c.name, *c.wantStamp)
		case c.wantStamp != nil && suspendedAt != nil && !suspendedAt.Equal(*c.wantStamp):
			t.Errorf("%s: suspendedAt got %v want %v", c.name, *suspendedAt, *c.wantStamp)
		}
	}
}
