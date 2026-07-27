// node --test tests/wiring.test.mjs
//
// The pure decision functions were already tested. This tests the WIRING: that
// the extension registers the handlers it claims to, on the events it claims to,
// and that those handlers return the shapes Pi acts on.
//
// It exists because of a specific failure. Asked to commit without approval, the
// model declined on its own — citing a rule it had read in an earlier message —
// and never ran the command. No tool call, no gate invocation, and an outcome
// indistinguishable from the gate working. A politely refusing model looks exactly
// like a guardrail right up until you check whether anything was actually
// enforced.
//
// So: no model, no Pi session, no cooperation. Fire the events and read the
// returns.

import assert from "node:assert/strict";
import { test } from "node:test";

import gitGate from "../extensions/git-gate.ts";
import modelGate from "../extensions/model-gate.ts";

/** Minimal stand-in for Pi's ExtensionAPI: records handlers so tests can fire them. */
function fakePi() {
	const handlers = new Map();
	return {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		// Handlers may be sync or async — ExtensionHandler allows both, and the two
		// gates here differ. Awaiting unconditionally is the only shape that tests
		// what Pi actually does; reading .action off an un-awaited Promise silently
		// reports every async gate as not firing.
		async fire(event, payload, ctx) {
			const hs = handlers.get(event) ?? [];
			return Promise.all(hs.map(async (h) => (await h(payload, ctx)) ?? {}));
		},
		registered: () => [...handlers.keys()].sort(),
	};
}

const ctx = (model) => ({
	model: model ? { id: model } : undefined,
	ui: { notify() {}, setStatus() {} },
});

// ---------------------------------------------------------------------------

test("git-gate registers on the events it needs", async () => {
	const pi = fakePi();
	gitGate(pi);
	assert.deepEqual(pi.registered(), ["agent_end", "input", "tool_call"]);
});

test("a bash git commit with no approval returns block:true", async () => {
	// The assertion the model's refusal was standing in for.
	const pi = fakePi();
	gitGate(pi);
	const [r] = await pi.fire("tool_call",
		{ toolName: "bash", input: { command: "git add -A && git commit -m x" } }, ctx("m"));
	assert.equal(r.block, true);
	assert.match(r.reason, /needs an operator approval/);
});

test("interactive APPROVE CHECKPOINT unblocks the same command", async () => {
	const pi = fakePi();
	gitGate(pi);
	await pi.fire("input", { text: "do it — APPROVE CHECKPOINT", source: "interactive" }, ctx("m"));
	const [r] = await pi.fire("tool_call",
		{ toolName: "bash", input: { command: "git commit -m x" } }, ctx("m"));
	assert.equal(r.block, undefined, "approved commit was blocked");
});

test("an extension-injected APPROVE CHECKPOINT does NOT unblock", async () => {
	const pi = fakePi();
	gitGate(pi);
	await pi.fire("input", { text: "APPROVE CHECKPOINT", source: "extension" }, ctx("m"));
	const [r] = await pi.fire("tool_call",
		{ toolName: "bash", input: { command: "git push" } }, ctx("m"));
	assert.equal(r.block, true, "an injected input granted approval");
});

test("approval does not survive the turn", async () => {
	const pi = fakePi();
	gitGate(pi);
	await pi.fire("input", { text: "APPROVE CHECKPOINT", source: "interactive" }, ctx("m"));
	await pi.fire("agent_end", {}, ctx("m"));
	const [r] = await pi.fire("tool_call",
		{ toolName: "bash", input: { command: "git push" } }, ctx("m"));
	assert.equal(r.block, true, "approval leaked past the turn it was typed in");
});

test("APPROVE COMMIT is spent by one command", async () => {
	const pi = fakePi();
	gitGate(pi);
	await pi.fire("input", { text: "APPROVE COMMIT", source: "interactive" }, ctx("m"));
	const [first] = await pi.fire("tool_call",
		{ toolName: "bash", input: { command: "git commit -m one" } }, ctx("m"));
	const [second] = await pi.fire("tool_call",
		{ toolName: "bash", input: { command: "git commit -m two" } }, ctx("m"));
	assert.equal(first.block, undefined);
	assert.equal(second.block, true, "a single-use approval was reused");
});

test("non-bash tools and read-only git pass through untouched", async () => {
	const pi = fakePi();
	gitGate(pi);
	const [readTool] = await pi.fire("tool_call", { toolName: "read", input: { path: "x" } }, ctx("m"));
	const [status] = await pi.fire("tool_call",
		{ toolName: "bash", input: { command: "git status" } }, ctx("m"));
	assert.equal(readTool.block, undefined);
	assert.equal(status.block, undefined);
});

test("a bash call with no command string does not crash the handler", async () => {
	const pi = fakePi();
	gitGate(pi);
	const [r] = await pi.fire("tool_call", { toolName: "bash", input: {} }, ctx("m"));
	assert.equal(r.block, undefined);
});

// ---------------------------------------------------------------------------

test("model-gate registers on input and consumes a blocked prompt", async () => {
	const pi = fakePi();
	modelGate(pi);
	assert.deepEqual(pi.registered(), ["input"]);
	const [blocked] = await pi.fire("input", { text: "hgstrat\ngo" }, ctx("claude-sonnet-4-6"));
	assert.equal(blocked.action, "handled", "judgment prompt on a weak model was not consumed");
	const [ok] = await pi.fire("input", { text: "hgstrat\ngo" }, ctx("claude-opus-4-8"));
	assert.equal(ok.action, "continue");
});

test("model-gate lets ordinary prompts through on any model", async () => {
	const pi = fakePi();
	modelGate(pi);
	const [r] = await pi.fire("input", { text: "fix the parser" }, ctx("claude-haiku-4-5"));
	assert.equal(r.action, "continue");
});
