// The on-disk catalog of exposed skills (docs/a2a-design.md section 6.2, A0-5 issue #989).
//
// One JSON file per skill at ${XDG_CONFIG_HOME:-~/.config}/mercury/a2a/skills/<id>.json; the id
// is the file name and obeys the bot-alias discipline (filesystem-, systemd- and log-safe).
// Same load discipline as bot configs (dispatcher-bot-design.md section 4.1): one validated file
// per skill, unknown keys refused with a did-you-mean suggestion, one bad file reported without
// taking the others down.
//
// Every template is validated against the create-Run model at load, with a placeholder input,
// through the SAME validateCreateRequest POST /api/runs uses -- a skill that could not create a
// valid Run never appears on a card (section 6.2; the general form of the #785 fix). The checks
// that need server state (agent registered, preset/workflow resolvable) run at server load
// through the same admitCreateRequest create() uses (admitExposedSkills below, called by
// createApp): this file's LOADERS stay offline on purpose, so `host a2a validate` works on a
// host with no server and no database.

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  requireTemplateRepository,
  validateCreateRequest,
} from '../domain/createRequest.ts';
import { suggestionFor } from '../domain/suggestKey.ts';
import { findServerStampedField, serverStampedFieldMessage } from '../api/serverStampedFields.ts';
import { ForbiddenError } from '../domain/errors.ts';
import type { CreateRunInput, RunService } from '../runs/runService.ts';
import { BOT_ALIAS_RE } from '../host/bots/config.ts';
import { BOT_OWNER_PREFIX, type A2aExposedSkill } from './config.ts';

/** The caller text's default ceiling (section 6.7: text parts are capped at the skill's
 *  inputMaxChars; the default, not the ceiling). */
export const INPUT_MAX_CHARS_DEFAULT = 8000;
/**
 * The hard ceiling on inputMaxChars (A0-5): the input lands inside the operator's template task
 * text, which rides on the process command line for command-line adapters -- an unbounded input
 * is an argv overflow, so the ceiling is far below any OS ARG_MAX and far above any realistic
 * caller message.
 */
export const INPUT_MAX_CHARS_CEILING = 100_000;

/** Top-level keys of a skill file (section 6.2): a closed set, unknown keys refused with a suggestion. */
const SKILL_FILE_KEYS = ['name', 'description', 'owners', 'template', 'inputMaxChars'] as const;

/**
 * The placeholder that stands in for the caller text when a template is validated (#989):
 * "each template, with a placeholder input substituted, goes through validateCreateRequest".
 * It is deliberately boring: the surrounding task text is the operator's, and the placeholder
 * must neither look like instructions nor trip any shape check.
 */
const INPUT_PLACEHOLDER = 'a2a input placeholder';

/** The catalog directory on this host (section 6.2). */
export function skillsDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== '') return join(xdg, 'mercury', 'a2a', 'skills');
  return join(homedir(), '.config', 'mercury', 'a2a', 'skills');
}

/** The skill file for one id (the id was already checked against BOT_ALIAS_RE by the caller). */
export function skillFile(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(skillsDir(env), `${id}.json`);
}

/** Substitute the placeholder for the single `{{input}}` slot (the same slot the handler fills
 *  with the caller text at request time). */
export function withPlaceholderInput(task: string): string {
  return task.replace('{{input}}', INPUT_PLACEHOLDER);
}

export interface ExposedSkillLoad {
  /** The skills that passed every check -- the A2A config is built from exactly these. */
  skills: A2aExposedSkill[];
  /** One line per refused skill (id: finding). */
  findings: string[];
}

/**
 * Load and validate the catalog -- the OFFLINE half of section 6.2: id discipline, JSON,
 * closed shape, owners, the template through validateCreateRequest with a placeholder input,
 * and a repository naming a url or localPath. One bad file is reported without stopping the
 * others, and a file with a finding contributes no skill.
 *
 * No directory is no catalog: A2A stays off (section 6.1), which is not a finding.
 */
export function loadExposedSkills(env: NodeJS.ProcessEnv = process.env): ExposedSkillLoad {
  const dir = skillsDir(env);
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return { skills: [], findings: [] };
  }
  const skills: A2aExposedSkill[] = [];
  const findings: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue; // the catalog is the set of *.json files
    const id = entry.slice(0, -'.json'.length);
    const result = loadOneSkill(join(dir, entry), id);
    if (typeof result === 'string') findings.push(`${id}: ${result}`);
    else skills.push(result.skill);
  }
  return { skills, findings };
}

/** Validate one skill file by id (the `--skill` form of `host a2a validate`). */
export function loadOneSkillById(id: string, env: NodeJS.ProcessEnv = process.env): { skill: A2aExposedSkill } | string {
  return loadOneSkill(skillFile(id, env), id);
}

/** One skill file: the skill, or the first finding that refuses it. */
function loadOneSkill(path: string, id: string): { skill: A2aExposedSkill } | string {
  if (!BOT_ALIAS_RE.test(id)) {
    return `id must match ${BOT_ALIAS_RE.source} (the bot-alias discipline, section 6.2), got ${JSON.stringify(id)}`;
  }
  let rawText: string;
  try {
    rawText = readFileSync(path, 'utf8');
  } catch (err) {
    return `cannot read ${path}: ${(err as Error).message}`;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    return `not valid JSON: ${(err as Error).message}`;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return '(root) must be a JSON object';
  }
  const file = raw as Record<string, unknown>;
  for (const key of Object.keys(file)) {
    if (!(SKILL_FILE_KEYS as readonly string[]).includes(key)) {
      const s = suggestionFor(key, SKILL_FILE_KEYS);
      return `unknown key '${key}'${s ? ` (did you mean '${s}'?)` : ''}; allowed keys: ${SKILL_FILE_KEYS.join(', ')}`;
    }
  }
  if (typeof file.name !== 'string' || file.name.trim().length === 0) {
    return 'name must be a non-empty string';
  }
  if (typeof file.description !== 'string' || file.description.trim().length === 0) {
    return 'description must be a non-empty string';
  }
  if (!Array.isArray(file.owners) || file.owners.length === 0) {
    return 'owners must be a non-empty array of owner ids';
  }
  for (const owner of file.owners) {
    if (typeof owner !== 'string' || owner.length === 0) {
      return 'owners must be a non-empty array of owner ids';
    }
    if (owner === '*') {
      // Sections 2 and 6.3: a skill anyone may invoke has no owner rule, and bots are refused
      // on every A2A route -- so a bot owner id in the list would admit no one ever.
      return "owners cannot contain '*': every skill has an owner rule (sections 2, 6.3)";
    }
    if (owner.startsWith(BOT_OWNER_PREFIX)) {
      return `owners cannot contain a bot owner id (${owner}): bots are refused on every A2A route (section 6.3)`;
    }
  }
  if (file.template === null || typeof file.template !== 'object' || Array.isArray(file.template)) {
    return 'template must be a JSON object (a create-request body)';
  }
  const template = file.template as Record<string, unknown>;
  // The template may not carry a field only the server may write: the route that fills the slot
  // forwards named fields, so `ownerId`/`status` in a template would be silently dropped and
  // the operator would believe they set them (the #988 rule, applied at the boundary).
  const stamped = findServerStampedField(template);
  if (stamped) return serverStampedFieldMessage(stamped);
  if (typeof template.task !== 'string') {
    return 'template.task must be a string carrying exactly one {{input}}';
  }
  const slots = (template.task as string).split('{{input}}').length - 1;
  if (slots !== 1) {
    return `template.task must contain exactly one {{input}} slot, found ${slots}`;
  }
  // The template through the create-request validator, placeholder input substituted
  // (section 6.2; one validator, not two). The closed field set, every field's shape and the
  // #785 rule (a repository naming a url or localPath) all live in that one call.
  try {
    validateCreateRequest({ ...template, task: withPlaceholderInput(template.task as string) }, { requireRepository: true });
  } catch (err) {
    return (err as Error).message;
  }
  if (file.inputMaxChars !== undefined) {
    const n = file.inputMaxChars;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > INPUT_MAX_CHARS_CEILING) {
      return `inputMaxChars must be an integer between 1 and ${INPUT_MAX_CHARS_CEILING}`;
    }
  }
  return {
    skill: {
      id,
      name: file.name as string,
      description: file.description as string,
      owners: file.owners as string[],
      template: template as A2aExposedSkill['template'],
      ...(file.inputMaxChars !== undefined ? { inputMaxChars: file.inputMaxChars as number } : {}),
    },
  };
}

// -- Server load (the other half of section 6.2) --

export interface A2aSkillAdmission {
  /** The skills that pass every check -- the A2A config the server exposes. */
  skills: A2aExposedSkill[];
  /** One line per refused or noted skill (`<id>: finding`). */
  findings: string[];
}

/**
 * The SERVER-LOAD half of section 6.2 (A0-5, #989): the checks the offline loader cannot run
 * -- the agent is registered, a named preset/workflow resolves, the capability matrices, the
 * credential profile -- run on every skill's template, with a placeholder input, through the
 * SAME `RunService.admitCreateRequest` `create()` uses. A skill that cannot create a valid Run
 * is not exposed and is reported; the caller of this function logs the findings.
 *
 * A credential-profile refusal is a per-caller runtime outcome (that owner is refused any Run
 * they create, over the native API included), not a skill defect: it does not block exposure,
 * it is reported so the operator sees which of the skill's owners cannot use it.
 */
export function admitExposedSkills(
  skills: readonly A2aExposedSkill[],
  runService: RunService,
): A2aSkillAdmission {
  const exposed: A2aExposedSkill[] = [];
  const findings: string[] = [];
  for (const skill of skills) {
    if (skill.owners.length === 0) {
      // The loader refuses an empty list; a programmatic config that skips it cannot invoke
      // the skill with anyone, so it is not exposed rather than checked under a fake owner.
      findings.push(`${skill.id}: owners is empty: no caller may invoke the skill`);
      continue;
    }
    const t = skill.template;
    const input: CreateRunInput = {
      // The server-state checks are owner-independent except the profile, which is per-caller;
      // the first owner is the representative the refusal report names.
      ownerId: skill.owners[0]!,
      task: withPlaceholderInput(t.task),
      repository: t.repository,
      ...(t.repositories !== undefined ? { repositories: t.repositories } : {}),
      ...(t.agent !== undefined ? { agent: t.agent } : {}),
      ...(t.skills !== undefined ? { skills: t.skills } : {}),
      ...(t.constraints !== undefined ? { constraints: t.constraints } : {}),
      ...(t.goal !== undefined ? { goal: t.goal } : {}),
      ...(t.knowledge !== undefined ? { knowledge: t.knowledge } : {}),
      ...(t.preset !== undefined ? { preset: t.preset } : {}),
      ...(t.workflow !== undefined ? { workflow: t.workflow } : {}),
      ...(t.model !== undefined ? { model: t.model } : {}),
    };
    try {
      runService.admitCreateRequest(input);
      exposed.push(skill);
    } catch (err) {
      if (err instanceof ForbiddenError) {
        findings.push(
          `${skill.id}: owner '${skill.owners[0]}' would be refused by a credential profile at create time: ${err.message}`,
        );
        exposed.push(skill);
      } else {
        findings.push(`${skill.id}: ${(err as Error).message}`);
      }
    }
  }
  return { skills: exposed, findings };
}
