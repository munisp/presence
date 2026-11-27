"""Batch 45 invariants — TECH-08 messaging crypto (e2eCrypto.ts).

The provider registry admits exactly OpenMLS/vodozemac and refuses
libsignal twice over (name AND AGPL marker); keys are pinned to the
device keystore; the key-package upload and the wire payload are
single-field by construction; the per-pair MLS epoch machine forms at
OPEN, seals at close and refuses out-of-order events; the compose path
screens before it encrypts, mandatory exactly when FR-38 says so.

These tests pin the contract source, the App-shell wiring, the README
row, the UX doc, the server-side ciphertext-only schema mirror, and the
regenerated traceability counts.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
E2E = (ROOT / "client/src/presence/e2eCrypto.ts").read_text()
E2E_TEST = (ROOT / "client/test/e2eCrypto.test.ts").read_text()
APP_TSX = (ROOT / "client/App.tsx").read_text()
README = (ROOT / "client/README.md").read_text()
UX_DOC = (ROOT / "docs/ux/e2e-crypto.md").read_text()
SCHEMA = (ROOT / "db/migrations/0001_init.sql").read_text()
TRACEABILITY = (ROOT / "docs/traceability.md").read_text()


def _imports(source: str) -> list[str]:
    """Return the module specifiers of every import statement."""
    return re.findall(r'import(?:\s+type)?[\s\S]*?from\s+"([^"]+)";', source)


# ---------------------------------------------------------------- module shape


def test_e2e_crypto_imports_only_the_cross_pinned_modules():
    assert _imports(E2E) == ["./dependencyBudget.js", "./conversationThread.js"]


def test_client_test_suite_exists():
    assert (ROOT / "client/test/e2eCrypto.test.ts").exists()


# ---------------------------------------------------------------- provider registry


def test_provider_registry_exactly_openmls_and_vodozemac():
    assert '{ name: "OpenMLS", ecosystem: "Rust", licenses: ["MIT", "Apache-2.0"] }' in E2E
    assert '{ name: "vodozemac", ecosystem: "Rust", licenses: ["MIT"] }' in E2E
    registry = E2E.split("ALLOWED_CRYPTO_PROVIDERS: readonly CryptoProvider[] = [", 1)[1].split("];", 1)[0]
    assert registry.count("ecosystem:") == 2


def test_libsignal_prohibition_pinned_with_srs_reason():
    assert 'PROHIBITED_CRYPTO_PROVIDERS = ["libsignal"] as const' in E2E
    assert '"AGPL-3.0 conflicts with a closed client"' in E2E


def test_provider_admission_refuses_by_name_and_licence():
    # Name screen first (case-insensitive substring over the banned list),
    # then exact registry membership, then the TECH-16 licence screen.
    assert "name.includes(banned.toLowerCase())" in E2E
    assert "allowed.name === provider.name" in E2E
    assert "provider.licenses.every((spdx) => licenceAllowed(spdx))" in E2E


# ---------------------------------------------------------------- key custody


def test_keys_pinned_to_the_device_keystore():
    assert 'PRIVATE_KEY_STORAGE = "secure-store"' in E2E
    assert "KEY_PACKAGE_REFILL_FLOOR = 10" in E2E


def test_key_package_upload_single_field_and_fail_closed():
    assert 'KEY_PACKAGE_UPLOAD_FIELDS = ["keyPackage"] as const' in E2E
    assert 'if (typeof keyPackage !== "string" || keyPackage.trim() === "") return null;' in E2E
    # Garbage counts fail closed toward refilling.
    assert "if (!Number.isFinite(remaining) || remaining < 0) return true;" in E2E


# ---------------------------------------------------------------- epoch machine


def test_epoch_machine_states_and_events_pinned():
    assert 'GROUP_STATES = ["pending", "active", "closed"] as const' in E2E
    for event in ("pair-open", "member-add", "member-remove", "message", "pair-close"):
        assert f'"{event}"' in E2E
    # Refusals: unknown event, message before open, anything after close.
    assert "if (!(EPOCH_EVENTS as readonly string[]).includes(event)) return null;" in E2E
    assert 'if (event === "pair-open") return { state: "active", epoch: group.epoch + 1 };' in E2E
    assert 'if (event === "pair-close") return { state: "closed", epoch: group.epoch + 1 };' in E2E


# ---------------------------------------------------------------- wire payload


def test_wire_payload_exactly_the_envelope():
    assert 'OUTBOUND_PAYLOAD_FIELDS = ["envelope"] as const' in E2E
    assert "return { envelope: envelopeBase64 };" in E2E


def test_plaintext_fields_are_violations():
    for field in ("body", "text", "plaintext", "preview", "snippet", "attachment"):
        assert f'"{field}"' in E2E
    assert 'violations.push(`plaintext:${field}`);' in E2E
    assert 'violations.push(`field:${field}`);' in E2E
    assert 'violations.push("envelope");' in E2E


def test_server_schema_mirrors_ciphertext_only():
    # The server half of FR-36 the client contract mirrors: one opaque
    # envelope column, plaintext pinned as never.
    assert "envelope   bytea NOT NULL,          -- MLS ciphertext; never plaintext" in SCHEMA


# ---------------------------------------------------------------- compose path


def test_compose_pipeline_screens_before_it_encrypts():
    assert 'COMPOSE_PIPELINE = ["screen", "encrypt", "send"] as const' in E2E
    assert 'composeRequiresScreening(sentCount) ? "required" : "not-required"' in E2E
    # The master guard pins the order and the FR-38 boundary.
    assert 'COMPOSE_PIPELINE.indexOf("screen") >= COMPOSE_PIPELINE.indexOf("encrypt")' in E2E
    assert 'planCompose(0).screening !== "required"' in E2E
    assert 'planCompose(1).screening !== "not-required"' in E2E


def test_master_guard_pins_libsignal_refusals():
    assert "e2eCryptoHonoursTech08" in E2E
    assert '"libsignal-client"' in E2E  # lookalike fork refuses
    # Licence laundering refuses too: a registered name carrying AGPL.
    assert 'name: "OpenMLS", ecosystem: "Rust", licenses: ["AGPL-3.0"]' in E2E


# ---------------------------------------------------------------- App shell


def test_app_wires_the_crypto_contract():
    assert 'from "./src/presence/e2eCrypto.js"' in APP_TSX
    assert "e2eCryptoHonoursTech08()" in APP_TSX
    assert 'buildOutboundPayload("Y2lwaGVydGV4dA==") !== null' in APP_TSX


def test_app_note_line_carries_batch_summary():
    assert "messages: MLS envelope only, keys on device" in APP_TSX
    assert "screen before encrypt" in APP_TSX
    assert "libsignal refused" in APP_TSX


# ---------------------------------------------------------------- docs


def test_readme_row_uses_full_requirement_id():
    assert "`src/presence/e2eCrypto.ts` | TECH-08:" in README


def test_ux_doc_maps_the_module():
    assert "e2eCrypto.ts" in UX_DOC
    assert "OpenMLS" in UX_DOC and "vodozemac" in UX_DOC
    assert "libsignal" in UX_DOC
    assert "screen → encrypt → send" in UX_DOC


# ---------------------------------------------------------------- traceability


def test_traceability_reclassifies_batch_45():
    rows = {
        line.split("|")[1].strip(): line
        for line in TRACEABILITY.splitlines()
        if line.startswith("| TECH-")
    }
    assert "| TECH-08 | implemented |" in rows["TECH-08"]
    # Batch 45: TECH-08 client → implemented: 231 → 232, 8 → 8, 1 → 0.
    # Batch 46: BR-07 + FR-89 client halves → implemented: 232 → 234, 8 → 6, 0 → 0.
    # Batch 70 closed TR-44 (the final phase-gated requirement): 234 → 235, phase-gated 1 → 0.
    assert "| implemented | 235 |" in TRACEABILITY
    assert "| partial | 6 |" in TRACEABILITY
    assert "| client | 0 |" in TRACEABILITY
