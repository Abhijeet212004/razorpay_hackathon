import { z } from "zod";

export const VERDICTS = ["ALLOW", "DENY", "STEP_UP"] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

export const REASON_CODES = [
  "OK-000",
  "AUT-001", "AUT-002",
  "MND-001", "MND-002", "MND-003",
  "LMT-001", "LMT-002", "LMT-003", "LMT-004", "LMT-005",
  "SCP-001", "SCP-002",
  "INT-001", "INT-002", "INT-003", "INT-004",
  "SEC-001", "SEC-002", "SEC-003", "SEC-004",
  "SYS-001", "SYS-002", "SYS-003",
  "STP-001", "STP-002", "STP-003",
] as const;

export const ReasonCodeSchema = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

/** A reason code belongs to exactly one verdict. */
export const VERDICT_FOR_REASON: Readonly<Record<ReasonCode, Verdict>> = {
  "OK-000": "ALLOW",
  "AUT-001": "DENY", "AUT-002": "DENY",
  "MND-001": "DENY", "MND-002": "DENY", "MND-003": "DENY",
  "LMT-001": "DENY", "LMT-002": "DENY", "LMT-003": "DENY", "LMT-004": "DENY", "LMT-005": "DENY",
  "SCP-001": "DENY", "SCP-002": "DENY",
  "INT-001": "DENY", "INT-002": "DENY", "INT-003": "DENY", "INT-004": "DENY",
  "SEC-001": "DENY", "SEC-002": "DENY", "SEC-003": "DENY", "SEC-004": "DENY",
  "SYS-001": "DENY", "SYS-002": "DENY", "SYS-003": "DENY",
  "STP-001": "STEP_UP", "STP-002": "STEP_UP", "STP-003": "STEP_UP",
};
