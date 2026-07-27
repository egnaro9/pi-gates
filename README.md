# pi-gates

**Refusal gates for [pi](https://pi.dev). They halt work that should not happen,
before it happens — and they fail closed when they cannot tell.**

```bash
pi install git:github.com/egnaro9/pi-gates
```

Then `/reload`, or restart Pi. Extensions load once at session start, so an update
leaves a running session executing the previous version.

Every session opens with a line naming what is armed:

```
pi-gates 0.2.0 armed: model-gate, git-gate — git commit/push needs APPROVE CHECKPOINT
```

That line exists because a stale install is silent. Three separate times while
building this, the code on disk was correct and the running system was not — a
package behind by nine commits, a session still holding the previous extension
after an update, an update that no-op'd — and nothing visible distinguished those
from working. An armed gate you cannot see is indistinguishable from no gate,
right up until you conclude from a commit going through that the gate is broken,
or from one being blocked that you are protected when you are not.

**If you do not see that line, the gates are not running.**

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

## `git-gate`

`git commit` and `git push` are denied unless an operator typed an approval at the
keyboard **this turn**:

```
BLOCKED — git commit/push needs an operator approval typed this turn.
Type APPROVE CHECKPOINT (covers the whole commit+push sequence) or
APPROVE COMMIT (one command). Approval is read from your keyboard input
only — this session cannot grant it to itself.
```

Everything else an agent does in a repo is recoverable by a human reading a diff.
A push is not. So this is a technical denial rather than an instruction to ask
nicely, and it holds regardless of what the model intends or has been told.

**The trust root is a source check.** Pi's `InputSource` is
`"interactive" | "rpc" | "extension"` — an extension can inject input. Approval is
honoured only from `"interactive"`. A gate that trusted any input event could be
opened by the thing it exists to gate.

**The matcher normalizes shell structure**, because every one of these hides
`git commit` from a prefix check and every one of them got through a previous
version:

```
(git commit && git push)   $(git commit)   `git push`   git commit&
{ git push; }              GIT_AUTHOR_NAME=x git commit
```

Read-only git is never gated. Over-blocking makes the gate the problem, and a gate
that is in the way gets switched off.

**`APPROVE CHECKPOINT` covers a whole sequence** — stage, commit, push, commit,
push — and clears at the end of the turn. `APPROVE COMMIT` is single-use. An
earlier version cleared on push, which denied the second commit of a two-commit
checkpoint and let a no-op push burn the approval.

## What the port removed

### model-gate

This began as a Claude Code `UserPromptSubmit` shell hook, and most of it was
machinery for one missing fact: *which model is running?* A `SessionStart` hook
wrote the id to `.runtime_model_<session_id>`; the gate read it back; a second
`.runtime_model_ppid_<PPID>` file existed only to cover the race where `/clear`
starts a new session before the startup hook has written the new file.

Three files, two hooks, one documented race, to learn the model.

Pi's `input` event hands the handler `ctx.model`. All of it is gone — not
refactored, deleted. What is left is the policy, which was always the only part
worth having.

### git-gate

The original carried its approval in a sentinel FILE, written by one hook, read by
a second, cleared by a third. A file is a thing the model can touch, so it also
needed a forge guard denying any command that so much as mentioned the sentinel's
name — with documented residuals around assembled paths like
`P=.oae_approve; touch "${P}_pending"`.

Here the approval is a variable in the extension's closure. There is no path from
a bash command to it. The forge guard is not hardened, it is **unnecessary**, and
the residuals it documented do not exist.

What did not carry over for free: the file version's trust root was "only the
UserPromptSubmit hook writes this". Pi's equivalent is the `source` check, and it
is easy to miss — the naive port trusts every `input` event and is grantable by an
extension.

## What does not port, and why

Two hooks from the original are deliberately absent.

**A blocking stop hook.** The original had a `Stop` hook that refused to let the
agent finish a turn if it had modified product source without running the
project's validation script. Pi has no equivalent: `agent_end`, `agent_settled`,
`turn_start` and `turn_end` are declared `ExtensionHandler<Event>` with no result
type, so a handler cannot return a decision. `message_end` can replace a message
but not force a continuation.

This is a real capability gap and not one to paper over. If you need the rule,
move the enforcement point rather than fake the hook: check the condition in
`tool_call` before `git commit`, where this package already sits. That is arguably
better — the original needed a `stop_hook_active` loop guard precisely because
blocking a stop is awkward — but it is a different gate, not a port, and it should
be described as one.

**Session-start context injection.** Half of the original's `SessionStart` hook
existed to write `.runtime_model_<sid>` for the model gate to read back. That half
is not ported because it is obsolete: `ctx.model` made the file unnecessary. The
other half injects standing project context, which is a real Pi capability
(`session_start`, and `before_agent_start` can return a `systemPrompt`) but is not
a gate and belongs to a harness's own configuration, not to a package about
refusals.

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
