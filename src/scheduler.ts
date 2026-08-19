/**
 * Fair Queue Scheduler Engine
 * Conforms to Architectural Invariant AD-7 & Cairo Operating Window
 */

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

  // Operating Window Rule (D5): Saturday to Thursday, 07:00 to 16:00 Cairo Time
  const allowedDays = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"];
  const isDayAllowed = allowedDays.includes(dayOfWeek);
  const isHourAllowed = hour >= 7 && hour < 16;

  const isWithinWindow = isDayAllowed && isHourAllowed;

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
