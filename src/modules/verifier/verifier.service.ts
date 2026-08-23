import { NotImplementedError } from "../../shared/errors.js";
import type { BlindVerifier, VerifierOutcome } from "./verifier.validation.js";

/**
 * INV-17: the blind verifier runs after stateless validation and before BEGIN, and can
 * only downgrade. It is a distinct stage, never a policy rule — a rule lives inside the
 * evaluator's fold, and anything in the fold could later be moved somewhere it grants.
 */

/** Deterministic implausibility check. Default when running against the replay rail. */
export function scriptedVerifier(): BlindVerifier {
  return {
    assess(): Promise<VerifierOutcome> {
      throw new NotImplementedError("verifier.service.scriptedVerifier", "Phase 2");
    },
  };
}

/** Real inference call, in a separate process holding no payment credential. */
export function claudeVerifier(): BlindVerifier {
  return {
    assess(): Promise<VerifierOutcome> {
      throw new NotImplementedError("verifier.service.claudeVerifier", "Phase 6");
    },
  };
}
