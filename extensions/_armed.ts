/**
 * Announce which gates are armed, at session start.
 *
 * Not decoration. Three times in one evening a stale install produced a confident
 * wrong conclusion: a package nine commits behind, a running session still holding
 * the previous extension after an update, and an update that silently did nothing.
 * In every case the code on disk was correct and the running system was not, and
 * nothing visible distinguished the two.
 *
 * An armed gate that is invisible is indistinguishable from no gate — right up
 * until you conclude from a passing commit that the gate is broken, or worse,
 * conclude from a blocked one that you are protected when you are not.
 *
 * So the gates say what they are and which build they came from, once, on the way
 * in. One line is cheap; a false sense of a guardrail is not.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));

export function version(): string {
	try {
		const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
		return String(pkg.version ?? "unknown");
	} catch {
		return "unknown";
	}
}

/** Kept as a literal list rather than derived: if a gate stops registering, this
 *  line still claims it, and the mismatch is the thing worth noticing. */
export const GATES = ["model-gate", "git-gate"] as const;

export function banner(v = version()): string {
	return `pi-gates ${v} armed: ${GATES.join(", ")} — git commit/push needs APPROVE CHECKPOINT`;
}

export default function armed(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify(banner(), "info");
	});
}
