package presence

import "testing"

// AMD-VERT parity: the Go mirror resolves exactly like the SQL definer and
// the edge gate. The cross-language pins live in tests/test_batch59.py.

func TestCatalogueShape(t *testing.T) {
	if len(VerticalCatalogue) != 10 {
		t.Fatalf("catalogue has %d entries, want 10", len(VerticalCatalogue))
	}
	if VerticalCatalogue[0].Vertical != VerticalDiscovery || !VerticalCatalogue[0].Locked {
		t.Fatalf("first catalogue entry must be the locked core, got %+v", VerticalCatalogue[0])
	}
	prev := -1
	for _, e := range VerticalCatalogue {
		if e.SortOrder <= prev {
			t.Fatalf("sort order must be strictly increasing, got %d after %d", e.SortOrder, prev)
		}
		prev = e.SortOrder
		if !e.DefaultEnabled {
			t.Fatalf("%s: every vertical ships default-on (backward compatibility)", e.Vertical)
		}
	}
}

func TestVerticalEnabledResolver(t *testing.T) {
	off := false
	on := true
	// Locked core: always on, even with an explicit narrowing row.
	if !VerticalEnabled(VerticalDiscovery, &off) {
		t.Fatal("the locked core can never be narrowed")
	}
	// No row → the catalogue default (on).
	if !VerticalEnabled(VerticalDating, nil) {
		t.Fatal("missing row must fall back to the catalogue default")
	}
	// Explicit rows win in both directions.
	if VerticalEnabled(VerticalDating, &off) {
		t.Fatal("an explicit off row must narrow")
	}
	if !VerticalEnabled(VerticalDating, &on) {
		t.Fatal("an explicit on row must hold")
	}
	// Unknown verticals fail closed.
	if VerticalEnabled(Vertical("bogus"), nil) {
		t.Fatal("unknown verticals fail closed")
	}
}

func TestVerticalForTemplate(t *testing.T) {
	cases := []struct {
		template string
		want     Vertical
		gated    bool
	}{
		{"/v1/dating/preferences", VerticalDating, true},
		{"/v1/dating", VerticalDating, true},
		{"/v1/marketplace/listings/mine", VerticalMarketplace, true},
		{"/v1/swaps/listings/mine", VerticalMarketplace, true},
		{"/v1/swaps/proposals", VerticalMarketplace, true},
		{"/v1/services/bookings/mine", VerticalServices, true},
		{"/v1/services/bookings", VerticalServices, true},
		{"/v1/transfers", VerticalPayments, true},
		{"/v1/wallets/:walletId/entries", VerticalPayments, true},
		{"/v1/presence/bond/release", VerticalTrust, true},
		{"/v1/met-receipts", VerticalTrust, true},
		{"/v1/escrows/:escrowId/dispute", VerticalTrust, true},
		{"/v1/disclosure-grants", VerticalTrust, true},
		{"/v1/attestation", VerticalTrust, true},
		{"/v1/introductions/:introId/answer", VerticalIntroductions, true},
		{"/v1/serendipity/windows/:windowId/state", VerticalSerendipity, true},
		{"/v1/rooms/:roomKey/join", VerticalVenues, true},
		{"/v1/tables/:tableId/join", VerticalVenues, true},
		{"/v1/slots/:slotId/book", VerticalVenues, true},
		{"/v1/announcements", VerticalVenues, true},
		{"/v1/presence/checkin", VerticalVenues, true},
		{"/v1/venues/:venueId/rooms", VerticalVenues, true},
		{"/v1/venues/abc123/rooms", VerticalVenues, true},
		{"/v1/groups/:tableId/stake", VerticalGroups, true},
		// Ungated: core discovery, account, moderation, ops surfaces.
		{"/v1/presence", "", false},
		{"/v1/account/verticals", "", false},
		{"/v1/moderation/wallets/:walletId/freeze", "", false},
		{"/v1/moderation/escrows/:escrowId/resolve", "", false},
		{"/v1/venues/:venueId/dashboard", "", false},
		{"/v1/venues/disclosure-verify", "", false},
		{"/v1/walletsmith", "", false}, // segment-boundary guard
	}
	for _, tc := range cases {
		got, gated := VerticalForTemplate(tc.template)
		if gated != tc.gated || got != tc.want {
			t.Errorf("VerticalForTemplate(%q) = (%q, %v), want (%q, %v)",
				tc.template, got, gated, tc.want, tc.gated)
		}
	}
}
