-- 2026-08-20: global-rules refactor (D5/D8/AD-11) — 9 new client profile columns
-- Safe on non-empty tables: NOT NULL requires a non-empty DEFAULT in SQLite/D1.
-- Legacy rows keep '' — decryptPII('') returns '' (src/crypto.ts), so reads stay safe.
-- Apply only with operator approval (spec: "Ask First — production D1 migration").

ALTER TABLE clients ADD COLUMN family_name_at_birth_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN place_of_birth TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN country_of_birth TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN nationality_at_birth TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN address_street_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN address_postal_code_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN address_city_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN passport_issue_date TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN passport_issuing_country TEXT NOT NULL DEFAULT '';
