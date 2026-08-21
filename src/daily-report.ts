import { getCairoDateString } from "./scheduler";

// ponytail: pure aggregation — no D1, no deps, testable
export interface ReportRow { job_id: string; client_id: string; event_type: string; details: string; created_at: string; }

function parseWeek(details: string): string {
  try { const d = JSON.parse(details || "{}"); return d.week || d.matchedMonday || ""; } catch { return ""; }
}

export function aggregateDailyReport(rows: ReportRow[], cairoDay: string) {
  const opps = new Map<string, { job_id: string; client_id: string; week: string; booked: boolean; lost: boolean }>();
  for (const r of rows) {
    if (!r.job_id) continue;
    if (r.event_type === "APPOINTMENT_FOUND") {
      const week = parseWeek(r.details);
      if (!week) continue;
      const key = `${r.job_id}|${week}`;
      if (!opps.has(key)) opps.set(key, { job_id: r.job_id, client_id: r.client_id, week, booked: false, lost: false });
    }
  }
  for (const r of rows) {
    if (!r.job_id) continue;
    const week = parseWeek(r.details);
    if (!week) continue;
    const key = `${r.job_id}|${week}`;
    if (r.event_type === "BOOKED" && opps.has(key)) opps.get(key)!.booked = true;
    if ((r.event_type === "SLOT_GONE_PRE_LAUNCH" || r.event_type === "BOOKING_FAILED") && opps.has(key)) opps.get(key)!.lost = true;
  }
  const opportunities = [...opps.values()];
  const missed = opportunities.filter(o => o.lost && !o.booked);
  const booked = opportunities.filter(o => o.booked);
  return {
    date: cairoDay,
    was_open: opportunities.length > 0,
    opportunities_found: opportunities.length,
    opportunities_booked: booked.length,
    opportunities_missed: missed.length,
    missed_details: missed,
  };
}

export function filterRowsByCairoDay(rows: ReportRow[], cairoDay: string): ReportRow[] {
  return rows.filter(r => {
    if (!r.created_at) return false;
    const ts = new Date(r.created_at.replace(" ", "T") + "Z");
    if (Number.isNaN(ts.getTime())) return false;
    try { return getCairoDateString(ts) === cairoDay; } catch { return false; }
  });
}
