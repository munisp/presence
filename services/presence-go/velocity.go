// Package presence implements the ARC-allocated Go presence service core
// (TECH-18): the pure domain logic of presence publishing — SEC-20 velocity
// rules, the FR-28 density budget ladder, and the canonical Valkey key model
// (FR-16/FR-23/FR-34/FR-91) — ported 1:1 from the TS edge so both
// implementations are held to the same constants and behaviour.
package presence

import (
	"fmt"
	"math"
	"time"
)

// EdgeKM is the H3 average edge length (km) at the storage resolutions
// (TR-12/14 ladder). Mirrors services/edge/src/velocity.ts.
var EdgeKM = map[int]float64{9: 0.1744, 10: 0.0659, 11: 0.0249}

// KmPerGridStep is the centre-to-centre distance between adjacent cells:
// edge * sqrt(3). Unsupported resolutions are an error, as in the TS port.
func KmPerGridStep(resolution int) (float64, error) {
	edge, ok := EdgeKM[resolution]
	if !ok {
		return 0, fmt.Errorf("unsupported H3 resolution %d", resolution)
	}
	return edge * math.Sqrt(3), nil
}

// MaxPlausibleKmh — SEC-20: deliberately generous so only teleports trip it.
const MaxPlausibleKmh = 500.0

// ImpliedSpeedKmh — SEC-20: implied speed between two presence fixes, in km/h.
// A non-positive elapsed time means infinite speed, exactly like the TS guard.
func ImpliedSpeedKmh(gridSteps int, resolution int, elapsed time.Duration) (float64, error) {
	if elapsed <= 0 {
		return math.Inf(1), nil
	}
	step, err := KmPerGridStep(resolution)
	if err != nil {
		return 0, err
	}
	km := float64(gridSteps) * step
	return km / elapsed.Hours(), nil
}

// IsImpossibleTravel — SEC-20: true when the move between two fixes is
// implausibly fast.
func IsImpossibleTravel(gridSteps int, resolution int, elapsed time.Duration) (bool, error) {
	speed, err := ImpliedSpeedKmh(gridSteps, resolution, elapsed)
	if err != nil {
		return false, err
	}
	return speed > MaxPlausibleKmh, nil
}

// SEC-20 anti-abuse ceilings (on top of the six-per-minute gateway burst
// limit, FR-24).
const (
	ScanHourlyMax = 200 // scans per account per hour
	WaveDailyMax  = 20  // waves (consent expresses) per account per day
)
