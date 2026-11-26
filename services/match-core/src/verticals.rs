//! AMD-VERT-01..05: vertical feature flags — Rust parity mirror.
//!
//! The SQL catalogue (db/migrations/0034_vertical_flags.sql) is the source
//! of truth; services/edge/src/verticals.ts is the edge gate; this module
//! is the match-core mirror so the Rust core reasons about the same ten
//! verticals the edge enforces. The batch-59/61 tests pin the SQL seed, the
//! edge mirror, the client mirror, the Go mirror and this module to the
//! same keys, order, locked core and gates.

/// The ten product verticals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Vertical {
    /// The locked core — never gateable.
    Discovery,
    Venues,
    Groups,
    Dating,
    Marketplace,
    Services,
    Payments,
    Trust,
    Introductions,
    Serendipity,
}

pub const LOCKED_VERTICAL: Vertical = Vertical::Discovery;

/// Mirror of one vertical_catalogue row.
#[derive(Debug, Clone, Copy)]
pub struct CatalogueEntry {
    pub vertical: Vertical,
    pub locked: bool,
    pub requires_kyc: bool,
    pub requires_adult: bool,
    pub default_enabled: bool,
    pub sort_order: i16,
}

/// Mirror of the seed insert, in sort order.
pub const CATALOGUE: [CatalogueEntry; 10] = [
    CatalogueEntry { vertical: Vertical::Discovery, locked: true, requires_kyc: false, requires_adult: false, default_enabled: true, sort_order: 0 },
    CatalogueEntry { vertical: Vertical::Venues, locked: false, requires_kyc: false, requires_adult: false, default_enabled: true, sort_order: 10 },
    CatalogueEntry { vertical: Vertical::Groups, locked: false, requires_kyc: true, requires_adult: false, default_enabled: true, sort_order: 20 },
    CatalogueEntry { vertical: Vertical::Dating, locked: false, requires_kyc: true, requires_adult: true, default_enabled: true, sort_order: 30 },
    CatalogueEntry { vertical: Vertical::Marketplace, locked: false, requires_kyc: true, requires_adult: false, default_enabled: true, sort_order: 40 },
    CatalogueEntry { vertical: Vertical::Services, locked: false, requires_kyc: true, requires_adult: false, default_enabled: true, sort_order: 45 },
    CatalogueEntry { vertical: Vertical::Payments, locked: false, requires_kyc: true, requires_adult: false, default_enabled: true, sort_order: 50 },
    CatalogueEntry { vertical: Vertical::Trust, locked: false, requires_kyc: true, requires_adult: false, default_enabled: true, sort_order: 60 },
    CatalogueEntry { vertical: Vertical::Introductions, locked: false, requires_kyc: true, requires_adult: false, default_enabled: true, sort_order: 70 },
    CatalogueEntry { vertical: Vertical::Serendipity, locked: false, requires_kyc: false, requires_adult: false, default_enabled: true, sort_order: 80 },
];

pub fn catalogue_entry(v: Vertical) -> &'static CatalogueEntry {
    CATALOGUE
        .iter()
        .find(|e| e.vertical == v)
        .expect("every Vertical variant has a catalogue row")
}

/// Mirror of the vertical_enabled definer: the locked core is always on;
/// an explicit row wins; otherwise the catalogue default. `explicit` is
/// None when the user holds no row for the vertical.
pub fn vertical_enabled(v: Vertical, explicit: Option<bool>) -> bool {
    let e = catalogue_entry(v);
    if e.locked {
        return true;
    }
    explicit.unwrap_or(e.default_enabled)
}

/// One ordered route-template rule: a segment-boundary prefix and its
/// vertical. `/v1/moderation/*` is deliberately absent — moderation
/// surfaces answer to workforce roles, not to consumer flags.
const TEMPLATE_RULES: [(&str, Vertical); 19] = [
    ("/v1/rooms", Vertical::Venues),
    ("/v1/tables", Vertical::Venues),
    ("/v1/slots", Vertical::Venues),
    ("/v1/announcements", Vertical::Venues),
    ("/v1/presence/checkin", Vertical::Venues),
    ("/v1/groups", Vertical::Groups),
    ("/v1/dating", Vertical::Dating),
    ("/v1/marketplace", Vertical::Marketplace),
    ("/v1/swaps", Vertical::Marketplace),
    ("/v1/services", Vertical::Services),
    ("/v1/transfers", Vertical::Payments),
    ("/v1/wallets", Vertical::Payments),
    ("/v1/presence/bond", Vertical::Trust),
    ("/v1/met-receipts", Vertical::Trust),
    ("/v1/escrows", Vertical::Trust),
    ("/v1/disclosure-grants", Vertical::Trust),
    ("/v1/attestation", Vertical::Trust),
    ("/v1/introductions", Vertical::Introductions),
    ("/v1/serendipity", Vertical::Serendipity),
];

/// Segment-boundary prefix match: exact equality, or the next character is
/// '/'. Keeps "/v1/wallets" from matching "/v1/walletsmith" while matching
/// "/v1/wallets/:walletId/entries".
fn segment_prefix_match(template: &str, prefix: &str) -> bool {
    template == prefix
        || template
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Resolve the vertical a route template belongs to, or None when the
/// template is ungated (account, consent, profile, moderation, taxonomy,
/// telemetry and ops surfaces stay open).
pub fn vertical_for_template(template: &str) -> Option<Vertical> {
    // Parameterised venue rooms: "/v1/venues/{anything}/rooms[/...]".
    if let Some(rest) = template.strip_prefix("/v1/venues/") {
        if let Some(i) = rest.find('/') {
            let tail = &rest[i + 1..];
            if tail == "rooms" || tail.starts_with("rooms/") {
                return Some(Vertical::Venues);
            }
        }
        return None;
    }
    TEMPLATE_RULES
        .iter()
        .find(|(prefix, _)| segment_prefix_match(template, prefix))
        .map(|(_, v)| *v)
}
