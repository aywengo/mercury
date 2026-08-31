// AgentAdapter contract (Mercury.md section 8).
// Mercury MUST NOT call agent-specific APIs outside this boundary.
//
// The interface itself lives in src/domain/types.ts, which is what the worker and every
// adapter implement against. This module used to declare its OWN copy, and the two drifted:
// `dispose` (issues #62, #97) had to be added in both places or the worker would not see it,
// which is a trap for the next person to extend the contract. Re-export instead.

import type { AgentAdapter } from '../domain/types.ts';

export type { AgentAdapter };
