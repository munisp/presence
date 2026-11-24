package venue

import (
	"testing"
	"time"
)

func TestValidate(t *testing.T) {
	var nilSchedule *OperatingSchedule
	if !nilSchedule.Validate() {
		t.Error("nil schedule must be valid (SQL NULL passes the CHECK)")
	}
	valid := &OperatingSchedule{
		Timezone: "Africa/Lagos",
		Weekly: []Window{
			{Day: "mon", Open: "08:00", Close: "22:00"},
			{Day: "sun", Open: "00:00", Close: "23:59"},
		},
	}
	if !valid.Validate() {
		t.Error("well-formed schedule rejected")
	}
	invalid := []*OperatingSchedule{
		{Weekly: []Window{{Day: "Mon", Open: "08:00", Close: "22:00"}}},    // uppercase day
		{Weekly: []Window{{Day: "monday", Open: "08:00", Close: "22:00"}}}, // long day
		{Weekly: []Window{{Day: "mon", Open: "24:00", Close: "22:00"}}},    // 24 rejected
		{Weekly: []Window{{Day: "mon", Open: "08:60", Close: "22:00"}}},    // 60 minutes
		{Weekly: []Window{{Day: "mon", Open: "8:00", Close: "22:00"}}},     // single digit hour
		{Weekly: []Window{{Day: "mon", Open: "08:00", Close: "10:00pm"}}},  // suffix
		{Weekly: []Window{{Day: "", Open: "08:00", Close: "22:00"}}},       // empty day
		{Weekly: []Window{{Day: "fri", Open: "", Close: "22:00"}}},         // empty open
		{Weekly: []Window{{Day: "wed", Open: "23:59", Close: "2:00"}}},     // single digit close hour
	}
	for i, s := range invalid {
		if s.Validate() {
			t.Errorf("invalid schedule %d accepted: %+v", i, s.Weekly[0])
		}
	}
	// Boundary times the SQL regex accepts.
	edge := &OperatingSchedule{Weekly: []Window{{Day: "sat", Open: "00:00", Close: "23:59"}}}
	if !edge.Validate() {
		t.Error("boundary times 00:00/23:59 must validate")
	}
}

func mustTime(t *testing.T, v string) time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339, v)
	if err != nil {
		t.Fatalf("bad test time %q: %v", v, err)
	}
	return ts
}

func TestIsOpenAt(t *testing.T) {
	// Africa/Lagos is UTC+1 year-round.
	schedule := &OperatingSchedule{
		Timezone: "Africa/Lagos",
		Weekly: []Window{
			{Day: "mon", Open: "08:00", Close: "22:00"}, // same-day window
			{Day: "fri", Open: "20:00", Close: "02:00"}, // overnight into Saturday
		},
	}
	cases := []struct {
		name string
		at   string // UTC instant
		want bool
	}{
		{"Monday noon Lagos", "2026-11-23T11:00:00Z", true},   // 12:00 WAT
		{"Monday before open", "2026-11-23T06:30:00Z", false}, // 07:30 WAT
		{"Monday exactly at open", "2026-11-23T07:00:00Z", true},
		{"Monday exactly at close", "2026-11-23T21:00:00Z", false}, // close is exclusive
		{"Friday evening", "2026-11-27T19:30:00Z", true},           // 20:30 WAT Friday
		{"overnight into Saturday", "2026-11-28T00:30:00Z", true},  // 01:30 WAT Saturday
		{"Saturday after wrap closes", "2026-11-28T01:30:00Z", false},
		{"Friday morning not covered", "2026-11-27T08:00:00Z", false},
	}
	for _, c := range cases {
		got, err := schedule.IsOpenAt(mustTime(t, c.at))
		if err != nil {
			t.Fatalf("%s: unexpected error %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}

	// Empty weekly and nil schedules are closed.
	empty := &OperatingSchedule{Timezone: "UTC"}
	if open, err := empty.IsOpenAt(mustTime(t, "2026-11-23T12:00:00Z")); err != nil || open {
		t.Error("empty weekly must be closed")
	}
	var nilSchedule *OperatingSchedule
	if open, err := nilSchedule.IsOpenAt(mustTime(t, "2026-11-23T12:00:00Z")); err != nil || open {
		t.Error("nil schedule must be closed")
	}

	// An unparseable timezone is an error, never a silent fallback.
	bad := &OperatingSchedule{Timezone: "Not/AZone", Weekly: []Window{{Day: "mon", Open: "00:00", Close: "23:59"}}}
	if _, err := bad.IsOpenAt(mustTime(t, "2026-11-23T12:00:00Z")); err == nil {
		t.Error("bad timezone must error")
	}

	// UTC default when no timezone is set.
	utcSched := &OperatingSchedule{Weekly: []Window{{Day: "mon", Open: "12:00", Close: "13:00"}}}
	open, err := utcSched.IsOpenAt(mustTime(t, "2026-11-23T12:30:00Z"))
	if err != nil || !open {
		t.Errorf("UTC default window should be open, got %v err %v", open, err)
	}
}
