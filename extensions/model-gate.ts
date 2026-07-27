/**
 * model-gate — refuse judgment work from a model that should not be doing it.
 *
 * Some roles in this harness are decision-making: strategy, criticism, evaluation.
 * Their output is trusted downstream and is expensive to unwind. They are meant to
 * run on a specific model tier, and the failure mode is silent — a cheaper model
 * answers a judgment prompt perfectly fluently and nothing marks the output as
 * having come from the wrong place.
 *
 * So this halts a judgment DECLARATION from an ineligible model, before the turn.
 *
 * Ported from a Claude Code UserPromptSubmit shell hook. That version had to
 * reconstruct which model was running: a SessionStart hook wrote the model id to
 * `.runtime_model_<session_id>`, this hook read it back, and a second
 * `.runtime_model_ppid_<PPID>` file existed purely to cover the race where /clear
 * starts a new session before the startup hook has written the new file. Three
 * files, two hooks, one documented race.
 *
 * Pi hands the handler `ctx.model`. All of that disappears — not simplified,
 * deleted. What remains is the actual policy.
 *
 * The one thing that does NOT change: it fails CLOSED. An unresolvable model on a
 * judgment declaration halts. A gate that opens when it is confused is not a gate.
 */

import type { ExtensionAPI, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";

/** Escape hatch. Present in the original and kept verbatim — a gate with no
 *  operator override becomes something people work around instead of through. */
export const OVERRIDE = /OVERRIDE MODEL GATE/i;

/** Roles whose output is a judgment. Everything else passes untouched. */
export const JUDGMENT_DECLARATION =
	/^[\s]*(?:hgstrat|hgcritic|hgcrit|hgopus)(?:\s|$)|^[\s]*(?:STRATEGY|CRITIC|EVAL)\s+SESSION/i;

/** Model ids permitted to hold a judgment role. */
export const ELIGIBLE = /^claude-opus-/i;

export type Decision =
	| { allow: true; reason: "override" | "not-a-judgment-role" | "eligible" }
	| { allow: false; reason: "unresolvable-model" | "ineligible-model"; model: string | null };

/**
 * The whole policy, as a pure function.
 *
 * Exported and tested directly because the interesting cases are the ones nobody
 * exercises by hand: a prompt that MENTIONS a role alias in its body, a session
 * with no model, a declaration on the wrong tier. The shell version acquired its
 * first-line-only rule after a live failure where a prompt discussing gate logic
 * tripped the gate on itself.
 */
export function decide(text: string, modelId: string | null | undefined): Decision {
	if (OVERRIDE.test(text)) return { allow: true, reason: "override" };

	// FIRST LINE ONLY. A declaration opens the prompt with the alias; body text
	// that merely discusses one must not trip the gate. Scanning the whole prompt
	// caused exactly that false positive in the original.
	const firstLine = text.split("\n", 1)[0] ?? "";
	if (!JUDGMENT_DECLARATION.test(firstLine)) {
		return { allow: true, reason: "not-a-judgment-role" };
	}

	if (!modelId) return { allow: false, reason: "unresolvable-model", model: null };
	if (ELIGIBLE.test(modelId)) return { allow: true, reason: "eligible" };
	return { allow: false, reason: "ineligible-model", model: modelId };
}

export function explain(d: Extract<Decision, { allow: false }>): string {
	if (d.reason === "unresolvable-model") {
		return (
			"MODEL GATE — no model resolved for this session, and this prompt declares a " +
			"judgment role.\nHalting: a gate that opens when it is confused is not a gate.\n" +
			"Pick a model with /model, or override with: OVERRIDE MODEL GATE — [reason]"
		);
	}
	return (
		`MODEL GATE — judgment roles are Opus-only. This session is on ${d.model}.\n` +
		"Halting before judgment work, because a cheaper model answers a judgment " +
		"prompt fluently and nothing downstream marks where the answer came from.\n" +
		"Switch with /model, or override with: OVERRIDE MODEL GATE — [reason]"
	);
}

export default function modelGate(pi: ExtensionAPI) {
	pi.on("input", async (event: InputEvent, ctx): Promise<InputEventResult> => {
		const d = decide(event.text, ctx.model?.id);
		if (d.allow) return { action: "continue" };

		// "handled" consumes the input: the agent never sees it. The operator does.
		ctx.ui.notify(explain(d), "error");
		return { action: "handled" };
	});
}
