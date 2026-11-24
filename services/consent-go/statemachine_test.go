package consent

import "testing"

func statePtr(s State) *State { return &s }

func TestConsentTransitionOK(t *testing.T) {
	// Exhaustive table pinned to consent_transition_ok() in migration 0001.
	states := []State{Detected, Nudged, Expressed, Mutual, Open}
	legal := map[State]map[State]bool{
		Detected:  {Nudged: true, Expressed: true},
		Nudged:    {Expressed: true},
		Expressed: {Mutual: true},
		Mutual:    {Open: true},
		Open:      {},
	}
	// New pair: only DETECTED is legal from NULL.
	for _, to := range states {
		if got := ConsentTransitionOK(nil, to); got != (to == Detected) {
			t.Errorf("nil -> %s: got %v want %v", to, got, to == Detected)
		}
	}
	for _, from := range states {
		for _, to := range states {
			want := legal[from][to]
			if got := ConsentTransitionOK(statePtr(from), to); got != want {
				t.Errorf("%s -> %s: got %v want %v", from, to, got, want)
			}
		}
	}
}

func TestMaskCloseReason(t *testing.T) {
	// FR-32: declined is reported as expired; FR-34: blocked is invisible.
	if got := MaskCloseReason(ReasonBlocked); got != nil {
		t.Errorf("blocked: got %v, want nil", *got)
	}
	if got := MaskCloseReason(ReasonDeclined); got == nil || *got != ReasonExpired {
		t.Errorf("declined: got %v, want expired", got)
	}
	for _, r := range []CloseReason{ReasonExpired, ReasonLapsed} {
		got := MaskCloseReason(r)
		if got == nil || *got != r {
			t.Errorf("%s: got %v, want %s", r, got, r)
		}
	}
}
