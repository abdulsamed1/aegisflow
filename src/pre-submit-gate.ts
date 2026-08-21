/**
 * Pre-submit gate — validates that a DecryptedClientData record has every
 * required field populated before the Playwright wizard is allowed to launch.
 * Pure function, no I/O.
 */
import { DecryptedClientData } from "./booking-http";

export interface GateResult {
  ready: boolean;
  blockers: string[];
}

export const CANONICAL_CALENDAR_ID = 44281520;
const KNOWN_CALENDAR_IDS = [CANONICAL_CALENDAR_ID] as const;
const VALID_GENDERS = ["Male", "Female"] as const;
const VALID_CATEGORIES = ["Bachelor"] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Returns READY_TO_SUBMIT when all checks pass, or BLOCKED with a list of
 * specific blockers when any check fails.
 */
export function checkPreSubmitGate(client: DecryptedClientData): GateResult {
  const blockers: string[] = [];

  // Required non-empty string fields (panel-owned static data)
  const requiredStrings: Array<[keyof DecryptedClientData, string]> = [
    ["firstName", "Firstname"],
    ["lastName", "Lastname"],
    ["familyNameAtBirth", "LastnameAtBirth"],
    ["placeOfBirth", "PlaceOfBirth"],
    ["countryOfBirth", "CountryOfBirth"],
    ["nationalityAtBirth", "NationalityAtBirth"],
    ["street", "Street"],
    ["postalCode", "Postcode"],
    ["city", "City"],
    ["passportIssueDate", "TraveldocumentDateOfIssue"],
    ["passportIssuingCountry", "TraveldocumentIssuingAuthority"],
    ["dob", "DateOfBirth"],
    ["nationality", "NationalityForApplication"],
    ["passportNumber", "TraveldocumentNumber"],
    ["passportExpiry", "TraveldocumentValidUntil"],
    ["email", "Email"],
    ["phone", "Telephone"],
  ];

  for (const [field, portalName] of requiredStrings) {
    const val = client[field];
    if (typeof val !== "string" || !val.trim()) {
      blockers.push(`Missing required field: ${field} (portal: ${portalName})`);
    }
  }

  // Enum fields
  if (!(VALID_GENDERS as readonly string[]).includes(client.gender)) {
    blockers.push(`Invalid gender: "${client.gender}" — must be Male or Female (portal: Sex)`);
  }
  if (!(VALID_CATEGORIES as readonly string[]).includes(client.category)) {
    blockers.push(`Invalid category: "${client.category}" — must be Bachelor`);
  }

  // CalendarId must be a known verified value
  if (!(KNOWN_CALENDAR_IDS as readonly number[]).includes(client.calendarId)) {
    blockers.push(`Unknown calendarId: ${client.calendarId} — must be one of ${KNOWN_CALENDAR_IDS.join(", ")}`);
  }

  // Date format validation (YYYY-MM-DD + valid calendar month/day)
  const dateFields: Array<[keyof DecryptedClientData, string]> = [
    ["dob", "DateOfBirth"],
    ["passportIssueDate", "TraveldocumentDateOfIssue"],
    ["passportExpiry", "TraveldocumentValidUntil"],
  ];
  for (const [field, portalName] of dateFields) {
    const val = client[field];
    if (typeof val === "string" && val.trim()) {
      if (!DATE_PATTERN.test(val)) {
        blockers.push(`Invalid date format for ${field}: "${val}" — expected YYYY-MM-DD (portal: ${portalName})`);
      } else {
        const [y, m, d] = val.split("-").map(Number);
        if (m < 1 || m > 12 || d < 1 || d > 31) {
          blockers.push(`Invalid date value for ${field}: "${val}" — month or day out of bounds (portal: ${portalName})`);
        }
      }
    }
  }

  return { ready: blockers.length === 0, blockers };
}
