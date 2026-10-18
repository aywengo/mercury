// The A2A boundary's configuration and off switch (docs/a2a-design.md section 6.1).
//
// Nothing here reads the environment or the filesystem. A2A is enabled by the composition root
// handing this module a config, exactly like every other optional surface in `createApp` -- so the
// switch is a value the server either has or does not, and "off" is the absence of the value rather
// than a flag someone has to remember to check in each route.

import type { RunConstraints, RepositoryContext } from '../domain/types.ts';
import type { RunService } from '../runs/runService.ts';

/** The spec's well-known agent-card URI (section 6.8). NOT under the A2A prefix. */
export const A2A_AGENT_CARD_PATH = '/.well-known/agent-card.json';
/** Where the REST binding's routes are mounted (section 6.1). */
export const A2A_PREFIX = '/a2a';
/** The protocol version Mercury speaks and advertises (section 5). */
export const A2A_PROTOCOL_VERSION = '1.0';
/**
 * The skill-selection extension (section 6.2): `SendMessageRequest` has no skill field, so v1
 * carries the skill id in the request's `metadata` under this key. Declared on the card with
 * `required: true`, so a client that does not declare it gets `ExtensionSupportRequiredError`
 * instead of having its text run against a repository somebody guessed.
 *
 * A GitHub URL rather than a domain we would have to own: the extension has no dereferenceable
 * document yet, and inventing a hostname for one would be a promise this project cannot keep.
 */
export const A2A_SKILL_SELECTION_EXTENSION = 'https://github.com/aywengo/mercury/a2a/extensions/skill-selection/v1';
/** The `metadata` key the skill id travels in (section 6.2). */
export const A2A_SKILL_ID_KEY = 'skillId';
/**
 * The bot owner-id prefix (`bot-<alias>`, `dispatcher-bot-design.md` section 4.2 -- the same form
 * `src/host/bots/keys.ts` writes). Section 6.3 refuses every bot owner on every A2A route, so this
 * is a security boundary rather than a naming convention; `test/a2aServer.test.ts` pins it against
 * the helper that produces the real owner id, so the two cannot drift apart silently.
 */
export const BOT_OWNER_PREFIX = 'bot-';

/**
 * One exposed skill: the operator's declaration of a piece of work an A2A caller may ask for
 * (section 6.2). The caller supplies TEXT and nothing else -- a Run needs a repository, an agent
 * and constraints, and #785 is what happens when one is created without them.
 *
 * In-process here. The on-disk catalog, its per-file validation and its load discipline are A1;
 * this type is the shape that loader has to produce, so the spike cannot be shaped by a convenient
 * shortcut the real loader would not allow.
 */
export interface A2aExposedSkill {
  id: string;
  name: string;
  description: string;
  /** Owner ids allowed to see and invoke the skill. A skill not listed for the caller does not
   *  exist for that caller: it is off the card and answers as an unknown skill. */
  owners: readonly string[];
  /** Everything except the caller's text, which replaces `{{input}}` in `template.task`. */
  template: {
    task: string;
    repository: RepositoryContext;
    agent?: string;
    constraints?: Partial<RunConstraints>;
  };
  /** Rejected above this many characters rather than truncated (section 6.7). */
  inputMaxChars?: number;
}

export interface A2aConfig {
  /** The operator's switch. Off by default, and off again when no skill is exposed. */
  enabled: boolean;
  /**
   * Absolute base URL as an A2A client reaches this host (no trailing slash). The card must
   * advertise a URL the client can actually call, and a card is fetched before anything else --
   * so this cannot be derived from the request that happened to fetch it.
   */
  publicUrl: string;
  skills: readonly A2aExposedSkill[];
  /** Card identity. Defaults keep a misconfigured host honest rather than nameless. */
  name?: string;
  description?: string;
}

export interface A2aDeps {
  runService: RunService;
  config: A2aConfig;
  /** The Mercury version reported on the card. */
  version: string;
  /**
   * The margin added to a Run's own deadline when a blocking `SendMessage` waits for it
   * (section 6.6). It covers the queue-to-terminal gap, which is host-dependent -- queue depth and
   * the worker's poll interval -- so an operator may need a different value than the default. The
   * wait's bound is corrected upward from each attempt's own persisted retry due time, so this is a
   * starting budget rather than the whole bound.
   */
  settleMarginMs?: number;
}

/**
 * Is A2A on? Two conditions, both required (section 6.1): the operator enabled it, AND at least
 * one skill is exposed. A card with no skills is not a smaller A2A server, it is a server that
 * cannot do anything -- and section 6.8 requires the public card to list no skills anyway, so an
 * empty catalog would be indistinguishable from an unconfigured one.
 */
export function a2aEnabled(config: A2aConfig): boolean {
  return config.enabled && config.skills.length > 0;
}

/** The skills this caller may see (section 6.2). Admins are not special here: `owners` is the rule. */
export function skillsForOwner(config: A2aConfig, ownerId: string): A2aExposedSkill[] {
  return config.skills.filter((skill) => skill.owners.includes(ownerId));
}
