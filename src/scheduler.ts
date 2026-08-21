/**
 * Fair Queue Scheduler Engine
 * Conforms to Architectural Invariant AD-7 & Cairo Operating Window
 */

import { CANONICAL_CALENDAR_ID } from "./pre-submit-gate";

export interface CairoTimeInfo {
  isWithinWindow: boolean;
  dayOfWeek: string;
  hour: number;
  formattedCairoTime: string;
}

export function getCairoTimeInfo(date: Date = new Date()): CairoTimeInfo {
  // Convert UTC time to Cairo Time (UTC+2 standard / UTC+3 DST)
  // Using Intl.DateTimeFormat for reliable timezone calculation
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    weekday: "long",
    hour: "numeric",
    minute: "numeric",
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  let dayOfWeek = "";
  let hour = 0;
  let minute = 0;

  for (const part of parts) {
    if (part.type === "weekday") dayOfWeek = part.value;
    if (part.type === "hour") hour = parseInt(part.value, 10);
    if (part.type === "minute") minute = parseInt(part.value, 10);
  }

  // Operating Window (D5 amended 2026-08-20): global Cairo window 07:00-18:00,
  // every day including Friday. No per-day list.
  // ponytail: hour granularity only — minute precision adds nothing here
  const isWithinWindow = hour >= 7 && hour < 18;

  return {
    isWithinWindow,
    dayOfWeek,
    hour,
    formattedCairoTime: `${dayOfWeek} ${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`
  };
}

export function calculateMondayString(targetDate: Date = new Date()): string {
  // Compute Monday date for BMEIA 'Monday' param (e.g. 10/5/2026 12:00:00 AM)
  const d = new Date(targetDate);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  const monday = new Date(d.setDate(diff));

  const month = monday.getMonth() + 1;
  const dateNum = monday.getDate();
  const year = monday.getFullYear();

  return `${month}/${dateNum}/${year} 12:00:00 AM`;
}

export const SCHEDULER_PICK_QUERY = `
  SELECT jobs.id, jobs.client_id, jobs.check_count,
         clients.calendar_id, clients.category, clients.first_name_enc, clients.last_name_enc,
         clients.family_name_at_birth_enc, clients.address_street_enc, clients.address_postal_code_enc,
         clients.address_city_enc, clients.place_of_birth, clients.country_of_birth,
         clients.nationality_at_birth, clients.passport_issue_date, clients.passport_issuing_country,
         clients.gender, clients.dob, clients.nationality, clients.passport_number_enc,
         clients.passport_expiry, clients.email_enc, clients.phone_enc
  FROM jobs
  JOIN clients ON jobs.client_id = clients.id
  WHERE jobs.enabled = 1
    AND jobs.status = 'ACTIVE'
    AND clients.calendar_id = ${CANONICAL_CALENDAR_ID}
    AND (jobs.backoff_until IS NULL OR jobs.backoff_until <= CURRENT_TIMESTAMP)
  ORDER BY jobs.last_check ASC
  LIMIT 3`;

// ponytail: minimal Cairo-day helper for reporting — uses stdlib Intl, no deps
const cairoDateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" });
export function getCairoDateString(date: Date = new Date()): string {
  return cairoDateFmt.format(date);
}

// ponytail: global rule — the horizon is a constant, not a parameter
export const HORIZON_WEEKS = 8;

export function rollingMondays(now: Date = new Date()): string[] {
  const mondays: string[] = [];
  let cursor = new Date(now.getTime());
  for (let i = 0; i < HORIZON_WEEKS; i++) {
    mondays.push(calculateMondayString(cursor));
    cursor = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  return mondays;
}
