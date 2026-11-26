//! AMD-VERT parity: the Rust mirror resolves exactly like the SQL definer
//! and the edge gate. The cross-language pins live in tests/test_batch59.py.

use match_core::verticals::{
    catalogue_entry, vertical_enabled, vertical_for_template, Vertical, CATALOGUE,
    LOCKED_VERTICAL,
};

#[test]
fn catalogue_shape() {
    assert_eq!(CATALOGUE.len(), 10);
    assert_eq!(CATALOGUE[0].vertical, Vertical::Discovery);
    assert!(CATALOGUE[0].locked);
    assert_eq!(LOCKED_VERTICAL, Vertical::Discovery);
    let mut prev = -1;
    for e in CATALOGUE.iter() {
        assert!(e.sort_order > prev, "sort order strictly increasing");
        prev = e.sort_order;
        assert!(e.default_enabled, "every vertical ships default-on");
    }
}

#[test]
fn resolver_semantics() {
    // Locked core: always on, even with an explicit narrowing row.
    assert!(vertical_enabled(Vertical::Discovery, Some(false)));
    // No row → the catalogue default (on).
    assert!(vertical_enabled(Vertical::Dating, None));
    // Explicit rows win in both directions.
    assert!(!vertical_enabled(Vertical::Dating, Some(false)));
    assert!(vertical_enabled(Vertical::Dating, Some(true)));
    // Every variant has a catalogue row.
    for v in [
        Vertical::Discovery,
        Vertical::Venues,
        Vertical::Groups,
        Vertical::Dating,
        Vertical::Marketplace,
        Vertical::Services,
        Vertical::Payments,
        Vertical::Trust,
        Vertical::Introductions,
        Vertical::Serendipity,
    ] {
        assert_eq!(catalogue_entry(v).vertical, v);
    }
}

#[test]
fn template_mapping() {
    let gated: [(&str, Vertical); 24] = [
        ("/v1/dating/preferences", Vertical::Dating),
        ("/v1/dating", Vertical::Dating),
        ("/v1/marketplace/listings/mine", Vertical::Marketplace),
        ("/v1/swaps/listings/mine", Vertical::Marketplace),
        ("/v1/swaps/proposals", Vertical::Marketplace),
        ("/v1/services/bookings/mine", Vertical::Services),
        ("/v1/services/bookings", Vertical::Services),
        ("/v1/transfers", Vertical::Payments),
        ("/v1/wallets/:walletId/entries", Vertical::Payments),
        ("/v1/presence/bond/release", Vertical::Trust),
        ("/v1/met-receipts", Vertical::Trust),
        ("/v1/escrows/:escrowId/dispute", Vertical::Trust),
        ("/v1/disclosure-grants", Vertical::Trust),
        ("/v1/attestation", Vertical::Trust),
        ("/v1/introductions/:introId/answer", Vertical::Introductions),
        ("/v1/serendipity/windows/:windowId/state", Vertical::Serendipity),
        ("/v1/rooms/:roomKey/join", Vertical::Venues),
        ("/v1/tables/:tableId/join", Vertical::Venues),
        ("/v1/slots/:slotId/book", Vertical::Venues),
        ("/v1/announcements", Vertical::Venues),
        ("/v1/presence/checkin", Vertical::Venues),
        ("/v1/venues/:venueId/rooms", Vertical::Venues),
        ("/v1/venues/abc123/rooms", Vertical::Venues),
        ("/v1/groups/:tableId/stake", Vertical::Groups),
    ];
    for (template, want) in gated {
        assert_eq!(vertical_for_template(template), Some(want), "{template}");
    }
    // Ungated: core discovery, account, moderation, ops surfaces.
    for template in [
        "/v1/presence",
        "/v1/account/verticals",
        "/v1/moderation/wallets/:walletId/freeze",
        "/v1/moderation/escrows/:escrowId/resolve",
        "/v1/venues/:venueId/dashboard",
        "/v1/venues/disclosure-verify",
        "/v1/walletsmith", // segment-boundary guard
    ] {
        assert_eq!(vertical_for_template(template), None, "{template}");
    }
}
