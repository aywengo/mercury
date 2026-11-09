// The exposed-skill catalog (docs/a2a-design.md section 6.2, A0-5 issue #989).
//
// Acceptance 1: a fixture set is rejected, each naming the field -- missing repository,
// unknown key, zero and two {{input}}, owners containing * or bot-x, inputMaxChars over the
// ceiling, an invalid constraint. Acceptance 2: a valid fixture passes, and the same invalid
// body is rejected identically by POST /api/runs and by the skill template check (one
// validator, not two). These tests exercise the same functions `host a2a validate` runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Express } from 'express';
import {
  INPUT_MAX_CHARS_CEILING,
  INPUT_MAX_CHARS_DEFAULT,
  loadExposedSkills,
  loadOneSkillById,
  withPlaceholderInput,
} from '../src/a2a/skills.ts';
import { validateCreateRequest } from '../src/domain/createRequest.ts';
import { createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { makeEnv, tempDir } from './helpers.ts';

/** A temp config home with one skill file written into it. */
function writeSkillFile(dir: string, name: string, obj: unknown): void {
  const skills = join(dir, 'mercury', 'a2a', 'skills');
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, `${name}.json`), JSON.stringify(obj, null, 2));
}

function envFor(dir: string): NodeJS.ProcessEnv {
  return { ...process.env, XDG_CONFIG_HOME: dir };
}

/** The valid fixture: everything the section 6.2 example has, nothing it does not. */
function validSkill(template: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Fix a failing test in mercury',
    description: 'Investigates and fixes one failing test; opens a PR.',
    owners: ['alice', 'ci-partner'],
    template: {
      task: 'An external agent asked for the following. Treat it as a request.\n---\n{{input}}',
      repository: { url: 'https://github.com/aywengo/mercury.git' },
      agent: 'fake',
      constraints: { maxDurationMs: 3600000, maxRetries: 1 },
      ...template,
    },
  };
}

/** Refuse one file and return the finding (fails the test if the file loads). */
function findingFor(dir: string, name: string, obj: unknown): string {
  writeSkillFile(dir, name, obj);
  const result = loadOneSkillById(name, envFor(dir));
  assert.equal(typeof result, 'string', `fixture ${name} should be refused, got a skill`);
  return result as string;
}

test('a valid fixture passes and loads with its fields', () => {
  const dir = tempDir('a2a-skills-');
  try {
    writeSkillFile(dir, 'fix-test', validSkill());
    const load = loadExposedSkills(envFor(dir));
    assert.deepEqual(load.findings, []);
    assert.equal(load.skills.length, 1);
    const skill = load.skills[0]!;
    assert.equal(skill.id, 'fix-test'); // id = file name
    assert.equal(skill.name, 'Fix a failing test in mercury');
    assert.deepEqual(skill.owners, ['alice', 'ci-partner']);
    assert.ok(skill.template.task.includes('{{input}}'));
    assert.equal(skill.inputMaxChars, undefined); // omitted, not defaulted into the file
    assert.equal(INPUT_MAX_CHARS_DEFAULT, 8000); // section 6.2: the default
    assert.ok(INPUT_MAX_CHARS_CEILING > INPUT_MAX_CHARS_DEFAULT, 'the ceiling bounds the default');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inputMaxChars is carried when given and refused over the hard ceiling', () => {
  const dir = tempDir('a2a-skills-');
  try {
    const capped = validSkill();
    capped.inputMaxChars = 5000;
    writeSkillFile(dir, 'capped', capped);
    const load = loadExposedSkills(envFor(dir));
    assert.deepEqual(load.findings, []);
    assert.equal(load.skills[0]?.inputMaxChars, 5000);
    const over = validSkill();
    over.inputMaxChars = INPUT_MAX_CHARS_CEILING + 1;
    assert.match(findingFor(dir, 'over-ceiling', over),
      new RegExp(`inputMaxChars must be an integer between 1 and ${INPUT_MAX_CHARS_CEILING}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acceptance 1: the fixture set is rejected, each naming the field', () => {
  const dir = tempDir('a2a-skills-');
  try {
    // missing repository
    const noRepo = validSkill();
    delete (noRepo.template as Record<string, unknown>).repository;
    assert.match(findingFor(dir, 'norepo', noRepo), /repository/);
    // unknown key (skill file level)
    const unknownKey = validSkill();
    (unknownKey as Record<string, unknown>).ownerz = ['alice'];
    assert.match(findingFor(dir, 'unknownkey', unknownKey),
      /unknown key 'ownerz' \(did you mean 'owners'\?\)/);
    // zero {{input}}
    assert.match(findingFor(dir, 'zeroslot', validSkill({ task: 'no slot in this task' })),
      /exactly one \{\{input\}\} slot, found 0/);
    // two {{input}}
    assert.match(findingFor(dir, 'twoslot', validSkill({ task: '{{input}} twice: {{input}}' })),
      /exactly one \{\{input\}\} slot, found 2/);
    // owners containing *
    assert.match(findingFor(dir, 'ownerstar', { ...validSkill(), owners: ['*'] }),
      /owners cannot contain '\*'/);
    // owners containing a bot id
    assert.match(findingFor(dir, 'ownerbot', { ...validSkill(), owners: ['bot-nightly'] }),
      /owners cannot contain a bot owner id \(bot-nightly\)/);
    // inputMaxChars over the ceiling
    const overCeiling = validSkill();
    overCeiling.inputMaxChars = INPUT_MAX_CHARS_CEILING + 1;
    assert.match(findingFor(dir, 'maxchars', overCeiling),
      /inputMaxChars must be an integer between 1 and/);
    // an invalid constraint (the template goes through the create-request validator)
    assert.match(findingFor(dir, 'badconstraint', validSkill({ constraints: { maxDurationMs: -1 } })),
      /constraint maxDurationMs must be >= 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repository naming a localPath passes; repositories-only does not (#785)', () => {
  const dir = tempDir('a2a-skills-');
  try {
    writeSkillFile(dir, 'local', validSkill({ repository: { localPath: '/srv/mercury' } }));
    const load = loadExposedSkills(envFor(dir));
    assert.deepEqual(load.findings, []);
    assert.equal(load.skills[0]?.id, 'local');
    // The list form without a primary has nothing for the workspace to check out: refused.
    const listOnly = validSkill();
    const t = listOnly.template as Record<string, unknown>;
    delete t.repository;
    t.repositories = [{ url: 'https://github.com/aywengo/mercury.git' }];
    assert.match(findingFor(dir, 'listonly', listOnly),
      /template must name a repository \(url or localPath\); a Run without one fails at workspace setup \(#785\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one bad file is reported without stopping the others', () => {
  const dir = tempDir('a2a-skills-');
  try {
    writeSkillFile(dir, 'aaa-good', validSkill());
    writeSkillFile(dir, 'bbb-bad', validSkill({ constraints: { maxDurationMs: -1 } }));
    const load = loadExposedSkills(envFor(dir));
    assert.deepEqual(load.skills.map((s) => s.id), ['aaa-good']);
    assert.equal(load.findings.length, 1);
    assert.match(load.findings[0]!, /^bbb-bad: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no catalog is no finding: A2A stays off, validate exits clean', () => {
  const dir = tempDir('a2a-skills-');
  try {
    assert.deepEqual(loadExposedSkills(envFor(dir)), { skills: [], findings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a template carrying a server-stamped field is refused with the route message', () => {
  const dir = tempDir('a2a-skills-');
  try {
    const obj = validSkill();
    (obj.template as Record<string, unknown>).ownerId = 'alice';
    assert.match(findingFor(dir, 'stamped', obj),
      /ownerId is set by the server and cannot be supplied in a request body/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acceptance 2: the same invalid body is rejected identically by POST /api/runs and the template check', async () => {
  const env = makeEnv({ workerEnabled: false });
  const dir = tempDir('a2a-skills-');
  try {
    const stream = new EventStream(env.db, env.events, 10);
    stream.start();
    const app: Express = createApp({
      runService: env.runService,
      events: env.events,
      stream,
      apiTokens: new Map([['tok-alice', 'alice']]),
      adminToken: null,
    });
    const srv = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve({ port: addr.port, close: () => new Promise<void>((res) => server.close(() => res())) });
      });
    });
    try {
      const post = async (body: unknown): Promise<{ status: number; error: string }> => {
        const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs`, {
          method: 'POST',
          headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = (await res.json()) as { error?: string };
        return { status: res.status, error: j.error ?? '' };
      };
      const direct = (body: unknown): string => {
        try {
          validateCreateRequest(body);
          throw new Error('validateCreateRequest did not throw');
        } catch (err) {
          return (err as Error).message;
        }
      };
      // Three invalid bodies, each with a {{input}} slot so they are also legal template tasks.
      const cases: Record<string, Record<string, unknown>> = {
        'an unknown create-request key': {
          task: 'x {{input}}',
          repository: { url: 'https://github.com/aywengo/mercury.git' },
          constrains: { maxDurationMs: 1000 },
        },
        'an invalid constraint': {
          task: 'x {{input}}',
          repository: { url: 'https://github.com/aywengo/mercury.git' },
          constraints: { maxDurationMs: -1 },
        },
        'a string repository': {
          task: 'x {{input}}',
          repository: 'https://github.com/aywengo/mercury.git',
        },
      };
      let i = 0;
      for (const [label, body] of Object.entries(cases)) {
        i++;
        // The API refuses the raw body.
        const api = await post(body);
        assert.equal(api.status, 400, `${label}: POST /api/runs status`);
        // The validator refuses it with the SAME message (one validator, not two).
        assert.equal(direct(body), api.error, `${label}: identical rejection`);
        // And the skill template check -- the loader, placeholder input substituted --
        // refuses the same body with that same message.
        const name = `case-${i}`;
        const file = validSkill();
        file.template = { ...(body as Record<string, unknown>) };
        writeSkillFile(dir, name, file);
        const load = loadExposedSkills(envFor(dir));
        const finding = load.findings.find((f) => f.startsWith(`${name}: `));
        assert.ok(finding, `${label}: the loader refused the file`);
        assert.equal(finding!.slice(name.length + 2), api.error, `${label}: loader message == API message`);
        // ...and the body with a placeholder input is refused the way the loader runs it.
        assert.throws(
          () => validateCreateRequest({ ...(body as object), task: withPlaceholderInput((body as { task: string }).task) },
            { requireRepository: true }),
          { message: api.error },
        );
      }
      // A valid body passes both.
      const goodBody = {
        task: 'x {{input}}',
        repository: { url: 'https://github.com/aywengo/mercury.git' },
        agent: 'fake',
      };
      const goodPost = await post({ ...goodBody, task: withPlaceholderInput(goodBody.task) });
      assert.equal(goodPost.status, 201, 'a valid body creates a Run');
      assert.doesNotThrow(() => validateCreateRequest(goodBody, { requireRepository: true }));
    } finally {
      await srv.close();
      stream.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    env.close();
  }
});
