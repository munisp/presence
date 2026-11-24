package venue

import "time"

// PartnerStatus is the governed lifecycle of the venue relationship (FR-42):
// 'prospect' venues are registered but not yet live; 'suspended' is the BR-14
// self-serve state; 'offboarded' is terminal (venue-ops only). The set is
// pinned to the CHECK constraint in db/migrations/0020_venue_registry.sql.
type PartnerStatus string

const (
	StatusProspect   PartnerStatus = "prospect"
	StatusActive     PartnerStatus = "active"
	StatusSuspended  PartnerStatus = "suspended"
	StatusOffboarded PartnerStatus = "offboarded"
)

// ValidPartnerStatus reports whether s is in the governed set.
func ValidPartnerStatus(s PartnerStatus) bool {
	switch s {
	case StatusProspect, StatusActive, StatusSuspended, StatusOffboarded:
		return true
	}
	return false
}

// SyncActive — exact port of the venues_sync_active trigger (migration 0020):
// active is derived, never set directly — a venue is live exactly when its
// partner status is 'active'. Entering 'suspended' stamps suspended_at;
// leaving it clears the stamp; staying suspended keeps the original stamp.
func SyncActive(newStatus, oldStatus PartnerStatus, oldSuspendedAt *time.Time, now time.Time) (active bool, suspendedAt *time.Time) {
	active = newStatus == StatusActive
	switch {
	case newStatus == StatusSuspended && oldStatus != StatusSuspended:
		stamped := now
		suspendedAt = &stamped
	case newStatus != StatusSuspended:
		suspendedAt = nil
	default:
		suspendedAt = oldSuspendedAt
	}
	return active, suspendedAt
}
