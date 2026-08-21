# 7. Verification & Acceptance Criteria

1. **Unit Tests**: Rule-matching logic tested with pure functions (window, horizon, calendar filtering).
2. **Integration Tests**: Scheduler queue sorting verified to prioritize oldest `last_check` over count; global-window gating (in/out of 07:00–18:00 Cairo) and rolling-horizon generation verified against the pure source module.
3. **Concurrency Test**: Simultaneous trigger of 2 workers on same client job resolves cleanly with exactly 1 DO lock acquisition and zero double bookings.
4. **Dry-Run Test**: End-to-end execution on live/mock portal stops before final submit and stores verification screenshot.
