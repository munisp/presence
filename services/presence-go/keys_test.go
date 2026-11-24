package presence

import (
	"testing"
	"time"
)

func TestCanonicalKeys(t *testing.T) {
	const a, b = "user-bbb", "user-aaa"
	// Either side of the relationship must compute the same key.
	if SuppressionKey(a, b) != SuppressionKey(b, a) {
		t.Error("suppression key not canonical")
	}
	if RotationKey(a, b) != RotationKey(b, a) {
		t.Error("rotation key not canonical")
	}
	if BlockKey(a, b) != BlockKey(b, a) {
		t.Error("block key not canonical")
	}
	// Canonical order is lexical: user-aaa < user-bbb.
	if got, want := SuppressionKey(a, b), "suppress:user-aaa:user-bbb"; got != want {
		t.Errorf("suppression key got %q want %q", got, want)
	}
	if got, want := RotationKey(a, b), "rotate:user-aaa:user-bbb"; got != want {
		t.Errorf("rotation key got %q want %q", got, want)
	}
	if got, want := BlockKey(a, b), "block:user-aaa:user-bbb"; got != want {
		t.Errorf("block key got %q want %q", got, want)
	}
	// TTLs pinned to the TS constants.
	if SuppressionTTL != 600*time.Second {
		t.Errorf("SuppressionTTL = %v, want 600s", SuppressionTTL)
	}
	if RotationTTL != 604_800*time.Second {
		t.Errorf("RotationTTL = %v, want 604800s", RotationTTL)
	}
}

func TestPresenceSessionID(t *testing.T) {
	id1, err := NewPresenceSessionID()
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	id2, err := NewPresenceSessionID()
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	// FR-16: 128-bit random, rendered as 32 lowercase hex characters.
	if len(id1) != 32 {
		t.Errorf("session id length got %d want 32", len(id1))
	}
	for _, r := range id1 {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			t.Errorf("session id contains non-hex %q", r)
		}
	}
	if id1 == id2 {
		t.Error("session ids must be unique")
	}
	if got, want := SessionKey(id1), "presence:session:"+id1; got != want {
		t.Errorf("session key got %q want %q", got, want)
	}
}
