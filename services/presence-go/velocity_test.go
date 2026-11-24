package presence

import (
	"math"
	"testing"
	"time"
)

func TestKmPerGridStep(t *testing.T) {
	// Centre-to-centre distance is edge * sqrt(3) — values pinned to the TS
	// port (services/edge/src/velocity.ts).
	cases := []struct {
		res  int
		want float64
	}{
		{9, 0.1744 * math.Sqrt(3)},
		{10, 0.0659 * math.Sqrt(3)},
		{11, 0.0249 * math.Sqrt(3)},
	}
	for _, c := range cases {
		got, err := KmPerGridStep(c.res)
		if err != nil {
			t.Fatalf("res %d: unexpected error %v", c.res, err)
		}
		if math.Abs(got-c.want) > 1e-12 {
			t.Errorf("res %d: got %v want %v", c.res, got, c.want)
		}
	}
	if _, err := KmPerGridStep(8); err == nil {
		t.Error("res 8: expected unsupported-resolution error")
	}
}

func TestImpliedSpeedKmh(t *testing.T) {
	step, _ := KmPerGridStep(9)
	// The duration that yields ≈500 km/h. Integer nanoseconds can't express
	// the exact boundary (the step length is irrational), so the strictly-
	// greater contract is asserted against the returned speed itself.
	boundary := time.Duration(step / MaxPlausibleKmh * float64(time.Hour))
	cases := []struct {
		name      string
		steps     int
		res       int
		elapsed   time.Duration
		wantSpeed float64
		tol       float64
		wantImp   bool
	}{
		{"stationary", 0, 9, time.Minute, 0, 1e-9, false},
		{"walk next door", 1, 9, 5 * time.Minute, step / (5.0 / 60.0), 1e-9, false},
		{"boundary", 1, 9, boundary, MaxPlausibleKmh, 1e-6, true},
		{"just over boundary teleports", 1, 9, boundary / 2, 2 * MaxPlausibleKmh, 1e-6, true},
		{"well under boundary is plausible", 1, 9, boundary * 2, MaxPlausibleKmh / 2, 1e-6, false},
		{"zero elapsed is infinite", 3, 10, 0, math.Inf(1), 0, true},
		{"negative elapsed is infinite", 3, 10, -time.Second, math.Inf(1), 0, true},
	}
	for _, c := range cases {
		speed, err := ImpliedSpeedKmh(c.steps, c.res, c.elapsed)
		if err != nil {
			t.Fatalf("%s: unexpected error %v", c.name, err)
		}
		if math.Abs(speed-c.wantSpeed) > c.tol {
			t.Errorf("%s: speed got %v want %v (tol %v)", c.name, speed, c.wantSpeed, c.tol)
		}
		imp, err := IsImpossibleTravel(c.steps, c.res, c.elapsed)
		if err != nil {
			t.Fatalf("%s: unexpected error %v", c.name, err)
		}
		// The comparison is strictly-greater, applied to the computed speed.
		if want := speed > MaxPlausibleKmh; imp != want {
			t.Errorf("%s: impossible got %v want %v (speed %v)", c.name, imp, want, speed)
		}
		if imp != c.wantImp {
			t.Errorf("%s: impossible got %v want %v", c.name, imp, c.wantImp)
		}
	}
	if _, err := IsImpossibleTravel(1, 8, time.Minute); err == nil {
		t.Error("res 8: expected unsupported-resolution error")
	}
}

func TestAntiAbuseCeilings(t *testing.T) {
	// SEC-20 ceilings, pinned to the TS constants.
	if ScanHourlyMax != 200 {
		t.Errorf("ScanHourlyMax = %d, want 200", ScanHourlyMax)
	}
	if WaveDailyMax != 20 {
		t.Errorf("WaveDailyMax = %d, want 20", WaveDailyMax)
	}
}
