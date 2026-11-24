package venue

import (
	"regexp"
	"time"
)

// FR-42: operating schedule shape — the exact regular expressions enforced by
// operating_schedule_valid() in db/migrations/0020_venue_registry.sql.
var (
	dayRe  = regexp.MustCompile(`^(mon|tue|wed|thu|fri|sat|sun)$`)
	timeRe = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)
)

// Window is one weekly opening window. Days are lowercase ISO abbreviations;
// times are 24-hour HH:MM.
type Window struct {
	Day   string `json:"day"`
	Open  string `json:"open"`
	Close string `json:"close"`
}

// OperatingSchedule mirrors the venues.operating_schedule jsonb document:
//
//	{ "timezone": "Africa/Lagos",
//	  "weekly": [ { "day": "mon", "open": "08:00", "close": "22:00" }, … ] }
type OperatingSchedule struct {
	Timezone string   `json:"timezone,omitempty"`
	Weekly   []Window `json:"weekly"`
}

// Validate — FR-42: exact port of the SQL shape check. A nil schedule is
// valid (the SQL check passes NULL through); a non-nil schedule must contain
// only well-formed windows.
func (s *OperatingSchedule) Validate() bool {
	if s == nil {
		return true
	}
	for _, w := range s.Weekly {
		if !dayRe.MatchString(w.Day) || !timeRe.MatchString(w.Open) || !timeRe.MatchString(w.Close) {
			return false
		}
	}
	return true
}

// hhmmToMinutes parses a validated HH:MM string into minutes since midnight.
func hhmmToMinutes(hhmm string) int {
	return int(hhmm[0]-'0')*600 + int(hhmm[1]-'0')*60 + int(hhmm[3]-'0')*10 + int(hhmm[4]-'0')
}

// weekdayAbbrev maps Go's Sunday-first weekdays onto the schedule's
// lowercase ISO abbreviations.
var weekdayAbbrev = [7]string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

// IsOpenAt reports whether the schedule is open at instant t, evaluated in
// the schedule's own timezone. Windows whose close precedes their open wrap
// past midnight onto the following day; an open equal to its close never
// opens. An empty or nil schedule is closed. An unparseable timezone is an
// error, never a silent fallback.
func (s *OperatingSchedule) IsOpenAt(t time.Time) (bool, error) {
	if s == nil || len(s.Weekly) == 0 {
		return false, nil
	}
	loc := time.UTC
	if s.Timezone != "" {
		l, err := time.LoadLocation(s.Timezone)
		if err != nil {
			return false, err
		}
		loc = l
	}
	lt := t.In(loc)
	today := weekdayAbbrev[int(lt.Weekday())]
	yesterday := weekdayAbbrev[(int(lt.Weekday())+6)%7]
	nowMin := lt.Hour()*60 + lt.Minute()
	for _, w := range s.Weekly {
		open := hhmmToMinutes(w.Open)
		cls := hhmmToMinutes(w.Close)
		switch {
		case cls > open: // same-day window
			if w.Day == today && nowMin >= open && nowMin < cls {
				return true, nil
			}
		case cls < open: // overnight window wraps past midnight
			if (w.Day == today && nowMin >= open) || (w.Day == yesterday && nowMin < cls) {
				return true, nil
			}
		}
	}
	return false, nil
}
