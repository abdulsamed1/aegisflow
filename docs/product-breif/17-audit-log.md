# 17. سجل الأحداث (Audit Log)

حقل في D1: `job_id, client_id, event, status, duration_ms, error_code, ts`

الأحداث: `NO_APPOINTMENT, APPOINTMENT_FOUND, RULE_MISMATCH, UNKNOWN_RESPONSE, BOOKING_STARTED, SUBMITTED, BOOKED, BOOKING_FAILED, BOOKING_RETRY, SLOT_GONE_PRE_LAUNCH, PRE_SUBMIT_BLOCKED, TEMPORARY_ERROR, PORTAL_ERROR, BUDGET_WARNING, NOTIFY_SENT, CLIENT_DELETED` — `DRY_RUN_STOPPED` أُلغي 2026-08-21 مع إزالة `DRY_RUN` (الحجز المباشر فقط).

- صف `UNKNOWN_RESPONSE` المجمّع لانقطاع النقل (2026-09-11): `{aggregatedTransportFailures, weeks, burstsSkipped, error}` بدل صف لكل أسبوع.
- `BOOKING_FAILED` يعيد المهمة `ACTIVE` **دون backoff** (`backoff_until = NULL` — never-park 2026-09-11).

---
