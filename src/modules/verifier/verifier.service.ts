import { NotImplementedError } from "../../shared/errors.js";
import type {
  BlindVerifier,
  VerifierInput,
  VerifierOutcome,
} from "./verifier.validation.js";

/**
 * INV-17: the blind verifier runs after stateless validation and before BEGIN, and can
 * only downgrade. It is a distinct stage, never a policy rule — a rule lives inside the
 * evaluator's fold, and anything in the fold could later be moved somewhere it grants.
 *
 * It is blind in a specific sense: it sees the request and the intent, never catalog
 * text. A verifier that read product descriptions would be reading exactly the content an
 * attacker controls, which is the opposite of what it is for.
 *
 * It is a heuristic with an unmeasured false-positive rate. Defence in depth only —
 * nothing here is load-bearing, and every check it makes is made again, deterministically,
 * under the mandate lock.
 */

/**
 * Instruction-shaped text in a field that is supposed to be a human-readable reason.
 * The rationale is display-only and no rule can read it, so this changes nothing about
 * what is permitted — it catches an agent that has plainly been got at, before the money
 * moves rather than after.
 */
const IMPLAUSIBLE = [
  /\bignore\s+(all\s+)?(previous\s+|prior\s+)?(limits?|instructions?|rules?)\b/i,
  /\b(system|assistant|developer)\s*:/i,
  /\bapprove\s+without\b/i,
  /\bdisregard\b.{0,24}\b(limit|policy|cap|rule)/i,
  /\boverride\b.{0,24}\b(limit|policy|cap|mandate)/i,
  /\bdo\s+not\s+(ask|confirm|verify)\b/i,
  /\bthe\s+(limits?|caps?)\s+do(es)?\s+not\s+apply\b/i,
];

/** Nothing legitimate reaches this. A rail ceiling exists too; this is far below it. */
const ABSURD_AMOUNT_PAISE = 10_000_000n;

export function assess(input: VerifierInput): VerifierOutcome {
  if (input.amountPaise >= ABSURD_AMOUNT_PAISE) {
    return { kind: "DENY", detail: "amount far outside any plausible basket" };
  }

  for (const pattern of IMPLAUSIBLE) {
    if (pattern.test(input.intent.rationale)) {
      return { kind: "DENY", detail: `rationale matched ${pattern.source}` };
    }
  }

  // Not a grant. It still faces every check from the mandate lock onward.
  return { kind: "PROCEED" };
}

/**
 * VERIFIER=scripted. Deterministic, so the red-team suite needs no model and a judge with
 * no credentials still exercises the stage.
 */
export function scriptedVerifier(): BlindVerifier {
  return {
    assess: (input) => Promise.resolve(assess(input)),
  };
}

/** VERIFIER=claude. Real inference, in a separate process holding no payment credential. */
export function claudeVerifier(): BlindVerifier {
  return {
    assess(): Promise<VerifierOutcome> {
      throw new NotImplementedError("verifier.service.claudeVerifier", "not built");
    },
  };
}

/** VERIFIER=off. Permitted only under RAIL=replay, and it records the skip every time. */
export function disabledVerifier(): BlindVerifier {
  return {
    assess: () => Promise.resolve({ kind: "PROCEED" as const }),
  };
}
