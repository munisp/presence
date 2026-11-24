package consent

import (
	"testing"
	"time"
)

func TestLifecycleConstants(t *testing.T) {
	// Pinned to services/edge/src/lifecycle.ts.
	if OfferTTL != 30*time.Minute {
		t.Errorf("OfferTTL = %v, want 30m", OfferTTL)
	}
	if ConversationTTL != 24*time.Hour {
		t.Errorf("ConversationTTL = %v, want 24h", ConversationTTL)
	}
	if PurgeAfterClose != 24*time.Hour {
		t.Errorf("PurgeAfterClose = %v, want 24h", PurgeAfterClose)
	}
	if LifecycleTick != time.Minute {
		t.Errorf("LifecycleTick = %v, want 1m", LifecycleTick)
	}
}

func TestIsOfferLive(t *testing.T) {
	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	past := now.Add(-time.Minute)
	future := now.Add(time.Minute)

	cases := []struct {
		name      string
		state     State
		closedAt  *time.Time
		expiresAt *time.Time
		want      bool
	}{
		{"detected with future deadline", Detected, nil, &future, true},
		{"detected without deadline", Detected, nil, nil, true},
		{"expressed live", Expressed, nil, &future, true},
		{"mutual live", Mutual, nil, &future, true},
		{"open is not an offer", Open, nil, &future, false},
		{"closed is dead", Detected, &past, &future, false},
		{"deadline exactly now is dead", Detected, nil, &now, false},
		{"deadline past is dead", Detected, nil, &past, false},
	}
	for _, c := range cases {
		if got := IsOfferLive(c.state, c.closedAt, c.expiresAt, now); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}
