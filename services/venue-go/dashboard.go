package venue

// DashboardInput carries the raw figures the venue dashboard computes from
// live presence sets and catalogue counts (BR-12).
type DashboardInput struct {
	LivePresence      int
	ScansLastHour     int
	ActiveOffers      int
	LiveAnnouncements int
	LiveEventPresence int
}

// DashboardOutput is what the venue sees — every figure k-suppressed (BR-13):
// below k the value is nil, rendered as "suppressed". The dashboard never
// serves user-level data at all.
type DashboardOutput struct {
	K                 int
	LivePresence      *int
	ScansLastHour     *int
	ActiveOffers      *int
	LiveAnnouncements *int
	LiveEventPresence *int
}

// BuildDashboard applies BR-13 suppression to every figure, mirroring the
// dashboard route in services/edge/src/routes/venue.ts.
func BuildDashboard(in DashboardInput) DashboardOutput {
	return DashboardOutput{
		K:                 KMin,
		LivePresence:      KSuppressed(in.LivePresence, KMin),
		ScansLastHour:     KSuppressed(in.ScansLastHour, KMin),
		ActiveOffers:      KSuppressed(in.ActiveOffers, KMin),
		LiveAnnouncements: KSuppressed(in.LiveAnnouncements, KMin),
		LiveEventPresence: KSuppressed(in.LiveEventPresence, KMin),
	}
}
