import { getCairoDateString } from "./scheduler";

// ponytail: module-level formatters — constructed once, not per row (see formatCairoTimestamp).
const cairoTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

export interface ReportRow {
  id?: number;
  job_id: string;
  client_id: string;
  event_type: string;
  duration_ms?: number;
  details: string;
  created_at: string;
}

export interface TimelineEntry {
  timestamp: string;
  cairo_time: string;
  cairo_date: string;
  job_id: string;
  client_id: string;
  event_type: string;
  week: string;
  slot?: string;
  stage?: string;
  correlation_id?: string;
  attempt?: number;
  classification?: string;
  status_badge: string;
  message: string;
  duration_ms?: number;
  raw_details: Record<string, any>;
  is_historical: boolean;
}

export interface DailySummary {
  date: string;
  was_open: boolean;
  opportunities_found: number;
  opportunities_booked: number;
  opportunities_missed: number;
  technical_failures: number;
}

export interface OpportunityRecord {
  job_id: string;
  client_id: string;
  week: string;
  booked: boolean;
  lost: boolean;
  technical_failed: boolean;
  classification?: string;
  last_error?: string;
  reference_id?: string;
}

function parseDetails(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function parseWeek(details: string): string {
  const d = parseDetails(details);
  return d.week || d.matchedMonday || "";
}

export function formatCairoTimestamp(isoOrDbString: string): { cairoDate: string; cairoTime: string } {
  if (!isoOrDbString) return { cairoDate: "", cairoTime: "" };
  const raw = isoOrDbString.replace(" ", "T");
  const iso = raw.endsWith("Z") ? raw : raw + "Z";
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return { cairoDate: "", cairoTime: "" };
  try {
    const cairoDate = getCairoDateString(ts);
    // ponytail: shared formatter — toLocaleTimeString builds one per call (~100µs);
    // at 10k rows that alone is ~1s CPU and the platform kills the isolate (HTTP 503).
    const cairoTime = cairoTimeFmt.format(ts);
    return { cairoDate, cairoTime };
  } catch {
    return { cairoDate: "", cairoTime: "" };
  }
}

export function formatBadgeAndMessage(
  eventType: string,
  details: Record<string, any>,
  week: string,
  attempt?: number
): { badge: string; message: string } {
  const cleanWeek = (week || "").replace(" 12:00:00 AM", "");
  switch (eventType) {
    case "APPOINTMENT_FOUND":
      return {
        badge: "رصد موعد",
        message: `رُصدت شبكة أسبوع بها مواعيد (${cleanWeek || "غير محدد"})`
      };
    case "BOOKING_STARTED":
      return {
        badge: `بدء الحجز (محاولة ${attempt || 1})`,
        message: `بدء تشغيل معالج الحجز للمرشح للأسبوع ${cleanWeek}`
      };
    case "SUBMITTED":
      return {
        badge: `إرسال النموذج (محاولة ${attempt || 1})`,
        message: `تم تقديم نموذج الحجز بالكامل وبانتظار رد المركز`
      };
    case "BOOKED":
      return {
        badge: "تم الحجز بنجاح ✓",
        message: `تم تأكيد الموعد بنجاح! رقم المرجع: ${details.referenceId || "—"}${details.retry ? " (بعد محاولة ثانية)" : ""}`
      };
    case "BOOKING_RETRY":
      return {
        badge: "إعادة المحاولة",
        message: `فشلت المحاولة الأولى (${details.error || "خطأ مؤقت"}) — جاري إعادة المحاولة فوراً`
      };
    case "SLOT_GONE_PRE_LAUNCH":
      return {
        badge: "الموعد فُقد مسبقاً",
        message: `تم إعادة فحص الأسبوع ${cleanWeek} قبل فتح المتصفح وتبين نفاد المواعيد`
      };
    case "PRE_SUBMIT_BLOCKED":
      return {
        badge: "حظر ما قبل الإرسال",
        message: `توقف الحجز لاكتمال الشروط: ${Array.isArray(details.blockers) ? details.blockers.join(", ") : details.blockers || "بيانات غير مكتملة"}`
      };
    case "BOOKING_FAILED": {
      const cls = details.classification || "";
      if (cls === "TRANSIENT_ERROR") {
        return {
          badge: "خطأ تقني مؤقت",
          message: `فشل تقني مؤقت بالمتصفح أو الشبكة (${details.error || "انقطاع"}). لم يتم تأكيد ضياع المقعد.`
        };
      }
      if (cls === "CAPTCHA_ERROR") {
        return {
          badge: "فشل التحقق (CAPTCHA)",
          message: `فشل التحقق البشري أو قراءة الرمز (${details.error || "خطأ في قراءة أو مطابقة الكابتشا"}). تم تصنيفه كفشل تقني.`
        };
      }
      if (cls === "SLOT_GONE") {
        return {
          badge: "نفاد المقعد",
          message: `المقعد لم يعد متاحاً على بوابة الوزارة أثناء الحجز (${details.error || "Slot gone"})`
        };
      }
      return {
        badge: "فشل الحجز",
        message: `فشلت المحاولة: ${details.error || cls || "خطأ غير محدد"}`
      };
    }
    case "UNKNOWN_RESPONSE":
      return {
        badge: "استجابة غير متوقعة",
        message: `استجابة غير قياسية من البوابة: ${details.error || "استجابة مجهولة"}`
      };
    default:
      return {
        badge: eventType,
        message: details.error || JSON.stringify(details)
      };
  }
}

export function aggregateDailyReport(rows: ReportRow[], cairoDay: string) {
  const opps = new Map<string, OpportunityRecord>();
  const timeline: TimelineEntry[] = [];

  // Pass 1: Identify all unique opportunities detected on this Cairo day
  for (const r of rows) {
    if (!r.job_id) continue;
    if (r.event_type === "APPOINTMENT_FOUND") {
      const week = parseWeek(r.details);
      if (!week) continue;
      const key = `${r.job_id}|${week}`;
      if (!opps.has(key)) {
        opps.set(key, {
          job_id: r.job_id,
          client_id: r.client_id,
          week,
          booked: false,
          lost: false,
          technical_failed: false
        });
      }
    }
  }

  // Pass 2: Process all rows chronologically to update state and construct timeline
  for (const r of rows) {
    if (!r.job_id) continue;
    // ponytail: skip routine high-volume scan ticks BEFORE parse/format — they never
    // create opportunities (no week) and are excluded from the timeline below.
    if (r.event_type === "NO_APPOINTMENT") continue;
    const details = parseDetails(r.details);
    const week = parseWeek(r.details);
    const key = week ? `${r.job_id}|${week}` : "";
    const opp = key ? opps.get(key) : undefined;

    // Distinguish slot-gone vs transient technical failure
    if (opp) {
      if (r.event_type === "BOOKED") {
        opp.booked = true;
        opp.lost = false;
        opp.technical_failed = false;
        if (details.referenceId) opp.reference_id = details.referenceId;
      } else if (r.event_type === "SLOT_GONE_PRE_LAUNCH") {
        if (!opp.booked) {
          opp.lost = true;
          opp.classification = "SLOT_GONE";
        }
      } else if (r.event_type === "PRE_SUBMIT_BLOCKED") {
        if (!opp.booked) {
          opp.technical_failed = true;
          opp.classification = "VALIDATION_ERROR";
        }
      } else if (r.event_type === "BOOKING_FAILED") {
        if (!opp.booked) {
          const cls = details.classification;
          opp.classification = cls || opp.classification;
          opp.last_error = details.error || opp.last_error;
          if (cls === "TRANSIENT_ERROR" || cls === "CAPTCHA_ERROR") {
            opp.technical_failed = true;
          } else {
            // SLOT_GONE, PORTAL_ERROR, SUBMISSION_ERROR, or legacy row with undefined classification
            opp.lost = true;
          }
        }
      }
    }

    // Routine high-volume scan ticks are skipped at the top of the loop.
    const { cairoDate, cairoTime } = formatCairoTimestamp(r.created_at);
    const attempt = typeof details.attempt === "number" ? details.attempt : undefined;
    const isHistorical = !details.correlationId && !details.classification && r.event_type !== "APPOINTMENT_FOUND";
    const { badge, message } = formatBadgeAndMessage(r.event_type, details, week, attempt);

    timeline.push({
      timestamp: r.created_at,
      cairo_time: cairoTime,
      cairo_date: cairoDate || cairoDay,
      job_id: r.job_id,
      client_id: r.client_id,
      event_type: r.event_type,
      week,
      slot: details.slot,
      stage: details.stage,
      correlation_id: details.correlationId,
      attempt,
      classification: details.classification,
      status_badge: badge,
      message,
      duration_ms: r.duration_ms,
      raw_details: details,
      is_historical: isHistorical
    });
  }

  const opportunities = [...opps.values()];
  const booked = opportunities.filter((o) => o.booked);
  const missed = opportunities.filter((o) => o.lost && !o.booked);
  const technical = opportunities.filter((o) => o.technical_failed && !o.lost && !o.booked);

  const summary: DailySummary = {
    date: cairoDay,
    was_open: opportunities.length > 0,
    opportunities_found: opportunities.length,
    opportunities_booked: booked.length,
    opportunities_missed: missed.length,
    technical_failures: technical.length
  };

  return {
    date: cairoDay,
    was_open: opportunities.length > 0,
    opportunities_found: opportunities.length,
    opportunities_booked: booked.length,
    opportunities_missed: missed.length,
    technical_failures: technical.length,
    missed_details: missed,
    timeline,
    summary
  };
}

export function filterRowsByCairoDay(rows: ReportRow[], cairoDay: string): ReportRow[] {
  return rows.filter((r) => {
    if (!r.created_at) return false;
    const { cairoDate } = formatCairoTimestamp(r.created_at);
    return cairoDate === cairoDay;
  });
}

export function summarizePriorCairoDays(allRows: ReportRow[]): DailySummary[] {
  const dayMap = new Map<string, ReportRow[]>();
  for (const r of allRows) {
    if (!r.created_at) continue;
    const { cairoDate } = formatCairoTimestamp(r.created_at);
    if (!cairoDate) continue;
    if (!dayMap.has(cairoDate)) dayMap.set(cairoDate, []);
    dayMap.get(cairoDate)!.push(r);
  }
  const sortedDates = [...dayMap.keys()].sort().reverse();
  return sortedDates.map((date) => {
    const agg = aggregateDailyReport(dayMap.get(date)!, date);
    return agg.summary;
  });
}

