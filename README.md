# pi-gates

**Refusal gates for [pi](https://pi.dev). They halt work that should not happen,
before it happens — and they fail closed when they cannot tell.**

```bash
pi install git:github.com/egnaro9/pi-gates
```

Then `/reload`, or restart Pi. Extensions load once at session start, so an update
leaves a running session executing the previous version.

## Why

An agent harness accumulates rules: this role runs on that model, that command
needs a human first, this file is not yours to write. Written as documentation,
those rules hold right up until the moment they matter — when the session is long,
the context is thin, and the model is confident.

A gate is the same rule expressed as a refusal. It does not depend on anyone
remembering.

The design constraint that makes them worth anything: **a gate that opens when it
is confused is not a gate.** Every gate here halts on an unresolvable state rather
than assuming the benign one, because the moment it cannot tell is exactly the
moment a mistake is likeliest.

## `model-gate`

Some roles produce judgments — strategy, criticism, evaluation — and their output
is trusted downstream and expensive to unwind. They are meant to run on a specific
model tier. The failure mode is silent: a cheaper model answers a judgment prompt
perfectly fluently, and nothing downstream marks where the answer came from.

So a judgment **declaration** from an ineligible model is halted before the turn:

```
MODEL GATE — judgment roles are Opus-only. This session is on claude-sonnet-4-6.
Halting before judgment work, because a cheaper model answers a judgment prompt
fluently and nothing downstream marks where the answer came from.
Switch with /model, or override with: OVERRIDE MODEL GATE — [reason]
```

Three properties that are not obvious and each cost something to learn:

**It reads the first line only.** A declaration opens the prompt with its alias.
A prompt that merely *mentions* one — say, a build task that discusses gate logic
— must not trip the gate. Scanning the whole prompt made the gate halt a session
for talking about itself.

**It fails closed on judgment work, and open on everything else.** No model
resolved plus a judgment declaration is a halt. No model resolved plus an ordinary
prompt passes: halting the whole session because nothing is selected would make
the gate the problem.

**The override is deliberate.** `OVERRIDE MODEL GATE — [reason]` passes anything,
including the fail-closed path. A gate with no operator escape becomes a thing
people route around instead of through, and then you have neither the gate nor the
knowledge that it was bypassed.

## What the port removed

This began as a Claude Code `UserPromptSubmit` shell hook, and most of it was
machinery for one missing fact: *which model is running?* A `SessionStart` hook
wrote the id to `.runtime_model_<session_id>`; the gate read it back; a second
`.runtime_model_ppid_<PPID>` file existed only to cover the race where `/clear`
starts a new session before the startup hook has written the new file.

Three files, two hooks, one documented race, to learn the model.

Pi's `input` event hands the handler `ctx.model`. All of it is gone — not
refactored, deleted. What is left is the policy, which was always the only part
worth having.

## Testing

The policy is a pure function, exported:

```ts
decide(text, modelId) -> { allow: true, reason } | { allow: false, reason, model }
```

```bash
node --test tests/*.test.mjs
```

Separated from the event wiring on purpose. The cases that matter are the ones
nobody exercises by hand — a body-only alias mention, an empty prompt, a missing
model — and two of the tests are transcribed from live failures of the shell
version this replaces.

## License

MIT
