/**
 * Report domain constants (PRS-SRS-001 §5.5).
 *
 * FR-49: the reporter picks from six fixed categories. The set is governed
 * here and enforced twice — the route's JSON Schema (TR-23, 400 on any
 * other value) and the reports.category CHECK constraint (migration 0019).
 * tests/test_reporting_compliance.py pins this list against the SQL so the
 * two cannot drift.
 *
 * Distinct from MODERATION_REASON_CODES (moderation.ts): categories are the
 * reporter's allegation; reason codes are the moderator's disposition.
 */

export const REPORT_CATEGORIES = [
  "harassment",
  "impersonation",
  "under_age",
  "commercial_solicitation",
  "hate",
  "other",
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
