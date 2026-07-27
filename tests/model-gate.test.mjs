// node --test tests/model-gate.test.mjs
//
// The gate's whole value is what it refuses, so the tests are mostly refusals and
// the near-misses around them. Two cases here are transcribed from live failures
// of the shell version this replaces.

import assert from "node:assert/strict";
import { test } from "node:test";

import { decide, explain } from "../extensions/model-gate.ts";

const OPUS = "claude-opus-4-8";
const SONNET = "claude-sonnet-4-6";

test("a judgment declaration on an eligible model passes", () => {
	assert.deepEqual(decide("hgstrat\n\nplan the next arc", OPUS),
		{ allow: true, reason: "eligible" });
	assert.equal(decide("STRATEGY SESSION\n\nwhat next?", OPUS).allow, true);
});

test("a judgment declaration on an ineligible model is halted", () => {
	const d = decide("hgcritic\n\nreview this", SONNET);
	assert.equal(d.allow, false);
	assert.equal(d.reason, "ineligible-model");
	assert.match(explain(d), /Opus-only/);
	assert.match(explain(d), new RegExp(SONNET));
});

test("a doing-role prompt is never model-checked", () => {
	// The spine runs on a cheaper model on purpose. Gating it would halt the
	// thing the harness spends most of its time doing.
	for (const p of ["hgstart\n\nbuild it", "EXECUTION SESSION\n\ngo", "fix the null deref"]) {
		assert.deepEqual(decide(p, SONNET), { allow: true, reason: "not-a-judgment-role" });
	}
});

test("a prompt that MENTIONS a judgment alias in its body does not trip the gate", () => {
	// Live failure F3 of the shell version: a doing prompt discussing gate logic
	// matched on a whole-prompt scan and halted itself. Hence first-line-only.
	const p = "fix the null deref in the parser\n\nnote: hgcritic uses this path too";
	assert.deepEqual(decide(p, SONNET), { allow: true, reason: "not-a-judgment-role" });
});

test("an alias must OPEN the line, not merely appear in it", () => {
	assert.equal(decide("please run hgstrat later", SONNET).allow, true);
});

test("an alias needs a word boundary — hgstratosphere is not hgstrat", () => {
	assert.equal(decide("hgstratosphere\n\ngo", SONNET).allow, true);
});

test("an unresolvable model on a judgment declaration FAILS CLOSED", () => {
	// The single most important case. A gate that opens when it cannot tell is
	// not a gate, and "no model selected" is exactly when a mistake is likeliest.
	for (const m of [null, undefined, ""]) {
		const d = decide("hgopus\n\njudge this", m);
		assert.equal(d.allow, false);
		assert.equal(d.reason, "unresolvable-model");
	}
	assert.match(explain(decide("hgopus", null)), /not a gate/);
});

test("an unresolvable model on a NON-judgment prompt still passes", () => {
	// Failing closed applies to judgment work, not to everything. Halting the
	// whole session because no model is set would make the gate the problem.
	assert.equal(decide("just do the thing", null).allow, true);
});

test("the override passes anything, including the fail-closed path", () => {
	assert.deepEqual(decide("hgstrat OVERRIDE MODEL GATE — one-off", SONNET),
		{ allow: true, reason: "override" });
	assert.equal(decide("hgopus\nOVERRIDE MODEL GATE — no model set", null).reason, "override");
});

test("declarations are matched case-insensitively and tolerate leading space", () => {
	assert.equal(decide("  HGSTRAT\n\ngo", SONNET).reason, "ineligible-model");
	assert.equal(decide("  strategy session\n\ngo", SONNET).reason, "ineligible-model");
});

test("an empty prompt is not a declaration", () => {
	assert.equal(decide("", SONNET).allow, true);
});
