// Shared exit settlement for every AgentAdapter (issue #148).
//
// Round 1 diagnosed this exactly: "Exit settlement is hand-rolled in five adapters with three
// different answers, one of them wrong ... the same bug is reproduced five times." Its remediation
// table promised a shared base as step 9 and marked it delivered. It never was: #102 and #111 patched
// only the daemon adapter and #103 added dispose() to all six individually. The row was accurate about
// the bugs and wrong about the fix.
//
// Six adapters had instead grown a byte-identical settleExit() -- verified by pairwise diff, not by
// eye -- plus their own exitSettled flag and exitResolve declaration. That is the mechanism round 1
// described, still available: docs/agent-adapters.md section 9 lists six MORE adapters as planned
// (Codex, ClaudeCode, Gemini, Aider, OpenHands, Devin), and each would re-implement this from scratch
// and inherit none of the six fixes.
//
// SCOPE, stated rather than assumed. This module owns exit settlement and the session-lifetime
// contract, which is the part that was provably identical and is the part the correctness argument was
// about. It deliberately does NOT own spawn or stderr buffering: those genuinely differ per backend --
// the daemon talks to a unix socket, the remote adapter speaks HTTP, and local/rpc spawn a child
// process -- and unifying them would be a rewrite with no evidence base, not the mechanical change
// this one is. The guard test in test/adapterExitSettlement.test.ts pins the part that is shared.

import type { AgentExit } from '../domain/types.ts';

/**
 * The part of a session that exit settlement touches.
 *
 * Deliberately structural rather than a base class to extend: an adapter's session type carries
 * whatever else its transport needs, and satisfying this interface is all that is required to use
 * settleExit(). That keeps adoption a one-line change per adapter instead of an inheritance
 * commitment.
 */
export interface ExitSettleable {
  /** Set true by the first settleExit() call; every later call is a no-op. */
  exitSettled: boolean;
  /** The resolver of the promise execute() returns on. Called at most once. */
  exitResolve: (exit: AgentExit) => void;
}

/**
 * Settle a session's exit EXACTLY ONCE.
 *
 * A transport can report completion through several independent paths -- the child's 'exit' event, a
 * stream end, a socket close, a cancel request, a timeout -- and they race. This makes the first
 * observation win and ignores the rest.
 *
 * WHAT THE GUARD DOES AND DOES NOT BUY TODAY, measured rather than assumed. Every adapter's
 * exitResolve is a plain promise resolver, and resolving an already-resolved promise is a no-op by
 * language semantics. Deleting the guard therefore leaves the resolved value AND the recorded reason
 * unchanged, and the full suite stays green (388/388) -- that was verified by mutation, and an earlier
 * revision of this comment claimed the second call could overwrite the reason, which is false.
 *
 * The guard is kept anyway, for two honest reasons. First, it makes first-writer-wins a stated local
 * property of this module instead of an emergent consequence of a language subtlety several files away,
 * which is what a reader needs to know when they change a transport. Second, it is the extension point:
 * the moment exitResolve does anything besides resolve -- emit an event, release a resource, record a
 * metric -- a second call stops being harmless, and the six adapters each have several racing paths.
 *
 * The test asserts the observable contract, that the resolver is invoked at most once, which is the
 * property the guard enforces and the only one it can be observed through.
 */
export function settleExit(session: ExitSettleable, exit: AgentExit): void {
  if (session.exitSettled) return;
  session.exitSettled = true;
  session.exitResolve(exit);
}

/**
 * Create the exit-promise pair a session needs, with the settled flag already initialised.
 *
 * Provided so an adapter cannot construct a session that is missing the guard flag -- the previous
 * shape had each adapter remember to declare `exitSettled: false` at every construction site.
 */
export function createExitGate(): {
  exitPromise: Promise<AgentExit>;
  exitResolve: (exit: AgentExit) => void;
  exitSettled: boolean;
} {
  let exitResolve!: (exit: AgentExit) => void;
  const exitPromise = new Promise<AgentExit>((resolve) => {
    exitResolve = resolve;
  });
  return { exitPromise, exitResolve, exitSettled: false };
}

/** The three session fields that make up the exit gate. */
export interface ExitGateHolder extends ExitSettleable {
  exitPromise: Promise<AgentExit>;
}

/**
 * Install a fresh exit gate on an existing session, clearing the settled flag.
 *
 * Thirteen call sites across the six adapters each hand-rolled the same four lines -- allocate a
 * promise, capture its resolver into the session, clear the settled flag -- and two of them captured
 * it through a `session!` non-null assertion because the session was not yet definitely assigned.
 * Routing construction through this helper means an adapter cannot create a session whose gate is
 * missing, or re-arm one and forget to clear the flag (which would make the retried run's exit
 * unresolvable, since settleExit() would see it as already settled).
 */
export function rearmExitGate<T extends ExitGateHolder>(session: T): T {
  const gate = createExitGate();
  session.exitPromise = gate.exitPromise;
  session.exitResolve = gate.exitResolve;
  session.exitSettled = gate.exitSettled;
  return session;
}
