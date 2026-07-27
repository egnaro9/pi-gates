/**
 * git-gate — `git commit` and `git push` require an operator's explicit approval,
 * typed at the keyboard, in the same turn.
 *
 * This is the gate on the irreversible path. Everything else an agent does in a
 * repo is recoverable by a human reading a diff; a push is not. So the rule is not
 * "ask nicely before committing" — it is a technical denial that holds regardless
 * of what the model intends, believes, or has been told.
 *
 * THE TRUST ROOT. Approval is granted only by an `input` event whose source is
 * "interactive" — the operator's keyboard. Pi's InputSource is
 * "interactive" | "rpc" | "extension", so an extension can inject input, and a
 * gate that accepted any input event could be granted by something that is not a
 * person. That check is the whole security property; everything below is detail.
 *
 * WHAT THE PORT DELETED. The Claude Code original carried the approval in a
 * sentinel FILE (`.oae_approve_pending`) written by one hook, read by a second,
 * cleared by a third. Because a file is a thing the model can touch, it also
 * needed a forge guard denying any Bash/Write/Edit that so much as mentioned the
 * sentinel's name — with documented residuals around assembled paths
 * (`P=.oae_approve; touch "${P}_pending"`).
 *
 * Here the approval is a variable in this module's closure. There is no path from
 * a bash command to it. The forge guard is not hardened, it is unnecessary — and
 * the residuals it documented do not exist.
 *
 * WHAT THE PORT KEPT, because it was paid for in real bypasses:
 *   - the normalizing matcher (see `isGatedGit`)
 *   - CHECKPOINT persisting across a whole commit/push sequence, COMMIT single-use
 *   - fail closed: unrecognised state denies
 */

import type {
	ExtensionAPI,
	InputEvent,
	InputEventResult,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

/** Exact phrases. Not "approve", not "yes, commit" — a phrase you cannot type by
 *  accident and cannot be talked into by a persuasive turn of conversation. */
export const CHECKPOINT = /\bAPPROVE CHECKPOINT\b/;
export const COMMIT_ONLY = /\bAPPROVE COMMIT\b/;

export type Scope = "CHECKPOINT" | "COMMIT" | null;

/**
 * Which approval an operator's message grants, if any.
 *
 * `source` is a parameter rather than read inside, so the trust-root rule is
 * visible at the call site and testable without an event bus.
 */
export function grantFrom(text: string, source: string): Scope {
	// Only a human at the keyboard. "extension" and "rpc" inputs are real and can
	// carry arbitrary text; honouring them would let the thing being gated open
	// the gate.
	if (source !== "interactive") return null;
	if (CHECKPOINT.test(text)) return "CHECKPOINT";
	if (COMMIT_ONLY.test(text)) return "COMMIT";
	return null;
}

/**
 * Does this bash command contain a gated git write?
 *
 * Ported behaviour-for-behaviour from the shell matcher, whose shape is the
 * residue of a real bypass set. Shell structure is normalised to newlines so the
 * LEADING token of every segment is exposed, then each segment is matched:
 *
 *   (git commit && git push)    subshell
 *   $(git commit)               command substitution
 *   `git push`                  backticks
 *   git commit&                 background
 *   { git push; }               brace group
 *   GIT_AUTHOR_NAME=x git commit   env-assignment prefix
 *
 * Every one of those hides `git commit` from a naive `startsWith` check.
 *
 * Documented residual, unchanged from the original: indirection through a quoted
 * string (`bash -c "git commit"`) is not caught here. The operator trust root is
 * the primary control; this matcher is depth, not the wall.
 */
export function isGatedGit(command: string): boolean {
	return normalizeSegments(command).some((seg) =>
		/^git\s+(commit|push)(\s|$)/.test(seg),
	);
}

function normalizeSegments(command: string): string[] {
	return command
		.replace(/[(){}<>&|;`]/g, "\n")
		.split("\n")
		.map((seg) =>
			seg
				.replace(/^\s+/, "")
				// strip any number of leading VAR=value prefixes
				.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ""),
		)
		.filter(Boolean);
}

export type GateState = { scope: Scope };

export type GateDecision =
	| { allow: true; consumed: boolean }
	| { allow: false; reason: string };

/**
 * The decision, as a pure function of (command, current approval).
 *
 * `consumed` reports whether this call used up the approval: COMMIT is single-use,
 * CHECKPOINT survives so that one approval covers stage → commit → push → commit
 * → push. An earlier version of the original cleared on push, which denied the
 * second commit of a two-commit checkpoint and let a no-op push burn the approval.
 */
export function decideGit(command: string, state: GateState): GateDecision {
	if (!isGatedGit(command)) return { allow: true, consumed: false };

	// Allowlist, not a denylist. Checking `scope === null` let undefined and ""
	// fall through to ALLOW — a fail-OPEN in the one function whose entire job is
	// to fail closed. Anything that is not an explicit grant denies.
	if (state.scope !== "CHECKPOINT" && state.scope !== "COMMIT") {
		return {
			allow: false,
			reason:
				"BLOCKED — git commit/push needs an operator approval typed this turn.\n" +
				"Type APPROVE CHECKPOINT (covers the whole commit+push sequence) or\n" +
				"APPROVE COMMIT (one command). Approval is read from your keyboard input\n" +
				"only — this session cannot grant it to itself.",
		};
	}
	return { allow: true, consumed: state.scope === "COMMIT" };
}

export default function gitGate(pi: ExtensionAPI) {
	// The approval. Reachable from this closure and nowhere else — in particular,
	// not from any bash command the model can write.
	const state: GateState = { scope: null };

	pi.on("input", (event: InputEvent, ctx): InputEventResult => {
		const granted = grantFrom(event.text, event.source);
		if (granted) {
			state.scope = granted;
			ctx.ui.notify(
				`git-gate: ${granted} approval granted for this turn.`,
				"info",
			);
		}
		return { action: "continue" };
	});

	pi.on("tool_call", (event: ToolCallEvent, ctx): ToolCallEventResult => {
		if (event.toolName !== "bash") return {};
		const command = String((event.input as { command?: unknown })?.command ?? "");

		const d = decideGit(command, state);
		if (!d.allow) {
			ctx.ui.notify(d.reason, "error");
			return { block: true, reason: d.reason };
		}
		if (d.consumed) state.scope = null;
		return {};
	});

	// Approval does not survive the turn it was typed in. Without this a single
	// APPROVE CHECKPOINT would authorise every future push in the session.
	pi.on("agent_end", () => {
		state.scope = null;
	});
}
