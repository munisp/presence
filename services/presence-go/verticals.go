package presence

import "strings"

// AMD-VERT-01..05: vertical feature flags — Go parity mirror.
//
// The SQL catalogue (db/migrations/0034_vertical_flags.sql) is the source
// of truth; services/edge/src/verticals.ts is the edge gate; this file is
// the Go-services mirror so the presence/venue/consent cores reason about
// the same nine verticals the edge enforces. The batch-59 tests pin the
// SQL seed, the edge mirror, the client mirror, this file and the Rust
// mirror to the same keys, order, locked core and gates.

// Vertical names one product vertical of the platform.
type Vertical string

const (
	VerticalDiscovery     Vertical = "discovery" // locked core
	VerticalVenues        Vertical = "venues"
	VerticalGroups        Vertical = "groups"
	VerticalDating        Vertical = "dating"
	VerticalMarketplace   Vertical = "marketplace"
	VerticalPayments      Vertical = "payments"
	VerticalTrust         Vertical = "trust"
	VerticalIntroductions Vertical = "introductions"
	VerticalSerendipity   Vertical = "serendipity"
)

// LockedVertical is the core that can never be narrowed.
const LockedVertical = VerticalDiscovery

// VerticalCatalogueEntry mirrors one vertical_catalogue row.
type VerticalCatalogueEntry struct {
	Vertical       Vertical
	Locked         bool
	RequiresKYC    bool
	RequiresAdult  bool
	DefaultEnabled bool
	SortOrder      int
}

// VerticalCatalogue mirrors the seed insert, in sort order.
var VerticalCatalogue = []VerticalCatalogueEntry{
	{VerticalDiscovery, true, false, false, true, 0},
	{VerticalVenues, false, false, false, true, 10},
	{VerticalGroups, false, true, false, true, 20},
	{VerticalDating, false, true, true, true, 30},
	{VerticalMarketplace, false, true, false, true, 40},
	{VerticalPayments, false, true, false, true, 50},
	{VerticalTrust, false, true, false, true, 60},
	{VerticalIntroductions, false, true, false, true, 70},
	{VerticalSerendipity, false, false, false, true, 80},
}

// CatalogueEntry returns the catalogue row for a vertical, or false.
func CatalogueEntry(v Vertical) (VerticalCatalogueEntry, bool) {
	for _, e := range VerticalCatalogue {
		if e.Vertical == v {
			return e, true
		}
	}
	return VerticalCatalogueEntry{}, false
}

// VerticalEnabled mirrors the vertical_enabled definer: the locked core is
// always on; an explicit row wins; otherwise the catalogue default.
// Unknown verticals fail closed. `explicit` is nil when the user holds no
// row for the vertical.
func VerticalEnabled(v Vertical, explicit *bool) bool {
	e, ok := CatalogueEntry(v)
	if !ok {
		return false
	}
	if e.Locked {
		return true
	}
	if explicit != nil {
		return *explicit
	}
	return e.DefaultEnabled
}

// templateRule binds a route-template prefix to a vertical. Rules evaluate
// in order; the first hit wins. Templates carry Fastify-style parameters
// ("/v1/groups/:tableId/stake"), so matching is by path segment, never by
// raw prefix string alone.
type templateRule struct {
	prefix   string
	vertical Vertical
}

var templateRules = []templateRule{
	{"/v1/rooms", VerticalVenues},
	{"/v1/tables", VerticalVenues},
	{"/v1/slots", VerticalVenues},
	{"/v1/announcements", VerticalVenues},
	{"/v1/presence/checkin", VerticalVenues},
	{"/v1/groups", VerticalGroups},
	{"/v1/dating", VerticalDating},
	{"/v1/marketplace", VerticalMarketplace},
	{"/v1/swaps", VerticalMarketplace},
	{"/v1/transfers", VerticalPayments},
	{"/v1/wallets", VerticalPayments},
	{"/v1/presence/bond", VerticalTrust},
	{"/v1/met-receipts", VerticalTrust},
	{"/v1/escrows", VerticalTrust},
	{"/v1/disclosure-grants", VerticalTrust},
	{"/v1/attestation", VerticalTrust},
	{"/v1/introductions", VerticalIntroductions},
	{"/v1/serendipity", VerticalSerendipity},
}

// segmentPrefixMatch reports whether template begins with prefix on a
// segment boundary: exact equality, or the next character is '/'. This
// keeps "/v1/wallets" from matching "/v1/walletsmith" while still matching
// "/v1/wallets/:walletId/entries".
func segmentPrefixMatch(template, prefix string) bool {
	if template == prefix {
		return true
	}
	return strings.HasPrefix(template, prefix+"/")
}

// VerticalForTemplate resolves the vertical a route template belongs to,
// or false when the template is ungated (account, consent, profile,
// moderation, taxonomy, telemetry and ops surfaces stay open).
func VerticalForTemplate(template string) (Vertical, bool) {
	// Parameterised venue rooms: "/v1/venues/{anything}/rooms[/...]".
	if strings.HasPrefix(template, "/v1/venues/") {
		rest := strings.TrimPrefix(template, "/v1/venues/")
		if i := strings.IndexByte(rest, '/'); i >= 0 {
			if tail := rest[i+1:]; tail == "rooms" || strings.HasPrefix(tail, "rooms/") {
				return VerticalVenues, true
			}
		}
		return "", false
	}
	for _, r := range templateRules {
		if segmentPrefixMatch(template, r.prefix) {
			return r.vertical, true
		}
	}
	return "", false
}
