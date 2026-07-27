// node --test tests/git-gate.test.mjs
//
// The bypass cases below are not hypothetical. They are the set the shell version
// of this gate was hardened against after each one got through, and they are the
// reason the matcher normalizes shell structure instead of checking a prefix.

import assert from "node:assert/strict";
import { test } from "node:test";

import { decideGit, grantFrom, isGatedGit } from "../extensions/git-gate.ts";

// ---------------------------------------------------------------------------
// the trust root
// ---------------------------------------------------------------------------

test("approval comes from interactive input and nothing else", () => {
	assert.equal(grantFrom("APPROVE CHECKPOINT", "interactive"), "CHECKPOINT");
	assert.equal(grantFrom("APPROVE COMMIT", "interactive"), "COMMIT");
});

test("an extension-injected input can NOT grant approval", () => {
	// Pi's InputSource is "interactive" | "rpc" | "extension". An extension can
	// inject input, so a gate that trusted any input event could be opened by
	// something that is not a person. This is the whole security property.
	assert.equal(grantFrom("APPROVE CHECKPOINT", "extension"), null);
	assert.equal(grantFrom("APPROVE CHECKPOINT", "rpc"), null);
});

test("the phrase must be exact", () => {
	for (const t of ["approve checkpoint", "Approve Checkpoint", "please approve",
	                 "APPROVED CHECKPOINT", "APPROVE THE CHECKPOINT", "yes commit it"]) {
		assert.equal(grantFrom(t, "interactive"), null, `granted on: ${t}`);
	}
});

test("the phrase is recognised inside a longer message", () => {
	assert.equal(
		grantFrom("looks good, ship it — APPROVE CHECKPOINT", "interactive"),
		"CHECKPOINT",
	);
});

// ---------------------------------------------------------------------------
// the matcher — every one of these hides `git commit` from a prefix check
// ---------------------------------------------------------------------------

test("plain gated commands are caught", () => {
	for (const c of ["git commit -m x", "git push", "git push origin HEAD"]) {
		assert.ok(isGatedGit(c), c);
	}
});

test("the documented bypass set is caught", () => {
	for (const c of [
		"(git commit && git push)",
		"(git commit)",
		"git push)",
		"git commit&",
		"$(git commit)",
		"`git push`",
		"{ git push; }",
		"GIT_AUTHOR_NAME=x git commit",
		"GIT_AUTHOR_NAME=x GIT_COMMITTER_NAME=y git push",
		"cd /tmp; git commit -m x",
		"true && git push",
		"ls | git commit",
	]) {
		assert.ok(isGatedGit(c), `bypass not caught: ${c}`);
	}
});

test("read-only and unrelated git is NOT gated", () => {
	// Over-blocking makes the gate the problem and gets it switched off.
	for (const c of ["git status", "git log --oneline", "git diff", "git add -A",
	                 "git rev-parse HEAD", "ls", "npm test"]) {
		assert.equal(isGatedGit(c), false, `over-blocked: ${c}`);
	}
});

test("a word that merely starts with a gated verb is not gated", () => {
	assert.equal(isGatedGit("git commitment-check"), false);
	assert.equal(isGatedGit("git pushd"), false);
});

test("mentioning the command in prose or a filename is not gated", () => {
	assert.equal(isGatedGit("echo 'run git commit later' > notes.txt"), false);
	assert.equal(isGatedGit("cat git-commit-guide.md"), false);
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

test("with no approval, a gated command is denied", () => {
	const d = decideGit("git push", { scope: null });
	assert.equal(d.allow, false);
	assert.match(d.reason, /cannot grant it to itself/);
});

test("with no approval, an ungated command still runs", () => {
	assert.deepEqual(decideGit("git status", { scope: null }), { allow: true, consumed: false });
});

test("COMMIT is single-use", () => {
	assert.deepEqual(decideGit("git commit -m x", { scope: "COMMIT" }),
		{ allow: true, consumed: true });
});

test("CHECKPOINT survives the whole sequence", () => {
	// An earlier version cleared on push. That denied the second commit of a
	// two-commit checkpoint, and let a no-op push burn the approval.
	const state = { scope: "CHECKPOINT" };
	for (const c of ["git commit -m one", "git push", "git commit -m two", "git push"]) {
		const d = decideGit(c, state);
		assert.equal(d.allow, true, c);
		assert.equal(d.consumed, false, `${c} consumed a CHECKPOINT`);
	}
});

test("an unrecognised scope fails CLOSED", () => {
	// Anything that is not an explicit grant denies. A gate that opens on a state
	// it does not understand is not a gate.
	assert.equal(decideGit("git push", { scope: undefined }).allow, false);
	assert.equal(decideGit("git push", { scope: "" }).allow, false);
});
