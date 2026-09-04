import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Node floor is stated in six places and enforced in none (issue #222).
//
// `engines` declared `>=23.6`, which was wrong in BOTH directions: it excluded Node 22 LTS, which
// passes the entire suite from 22.18, and it included Node 23, end-of-life since June 2025 and
// therefore receiving no security patches. The floor is set by two independent built-in features --
// flag-free `node:sqlite` (Node >= 22.13) and flag-free TypeScript type stripping, which production
// depends on because it runs `node src/cli.ts` with no build step (Node >= 22.18) -- so the honest
// floor is the later of the two. Both boundaries were measured against real Node binaries, not
// release notes: 22.13.0 has sqlite but cannot strip types, 22.17.1 still cannot, 22.18.0 can.
//
// Correcting it meant editing package.json, package-lock.json, README.md, QUICKSTART.md, this repo's
// setup guide and two test comments. Hand-editing six copies is exactly how they drift, and the
// previous drift was not cosmetic: the setup guide asserted "Node 20 or 22 will not start", which
// was false for 22.18+ and would have sent a working user away. So these tests pin the agreement.

const ROOT = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const ENGINES: string = JSON.parse(read('package.json')).engines.node;

function parseFloor(spec: string): [number, number] {
  const m = spec.match(/>=\s*(\d+)\.(\d+)/);
  assert.ok(m, `engines.node must be a >=MAJOR.MINOR floor, got ${spec}`);
  return [Number(m[1]), Number(m[2])];
}

function satisfies(v: [number, number], floor: [number, number]): boolean {
  return v[0] > floor[0] || (v[0] === floor[0] && v[1] >= floor[1]);
}

test('the declared floor is the version the two load-bearing features actually need (issue #222)', () => {
  const [major, minor] = parseFloor(ENGINES);
  // Below 22.13 there is no flag-free node:sqlite; below 22.18 `node file.ts` is a syntax error.
  // A floor under 22.18 would promise a runtime on which the server cannot even start.
  assert.ok(major > 22 || (major === 22 && minor >= 18),
    `floor ${ENGINES} is below 22.18, where type stripping still needs a flag`);
  // Node 23 is end-of-life and Node 22 LTS works; a floor above 22 would DROP a supported runtime
  // rather than add one, which is a support regression and must be a deliberate, separate decision.
  assert.equal(major, 22, `floor should stay on the 22 LTS line (Node 23 is EOL); got ${ENGINES}`);
});

test('every documented Node floor agrees with package.json engines (issue #222)', () => {
  const floor = parseFloor(ENGINES);
  const floorText = `${floor[0]}.${floor[1]}`;
  const docs = ['README.md', 'QUICKSTART.md', 'docs/remote-client-setup.md'];
  for (const doc of docs) {
    const stated = [...read(doc).matchAll(/Node(?:\.js)?\s*\|?\s*(?:>=|≥)\s*(\d+\.\d+)/g)].map((m) => m[1]);
    assert.ok(stated.length > 0, `${doc} must state a Node floor`);
    for (const s of stated) {
      assert.equal(s, floorText, `${doc} states Node ${s} but engines says ${floorText}`);
    }
  }
});

test('prose that names a required Node version agrees with engines (issue #222)', () => {
  // The setup guide also states the floor in running prose, not only in the table.
  const guide = read('docs/remote-client-setup.md');
  const prose = [...guide.matchAll(/Node must be (\d+\.\d+) or newer/g)].map((m) => m[1]);
  assert.ok(prose.length > 0, 'the setup guide must state the floor in prose, not only in a table');
  for (const p of prose) {
    assert.equal(p, `${parseFloor(ENGINES).join('.')}`, `setup guide prose says ${p}, engines says otherwise`);
  }
});

test('the setup guide does not declare a supported runtime unable to start (issue #222)', () => {
  // This is the defect that actually shipped: the guide asserted "Node 20 or 22 will not start"
  // while 22.18+ starts and passes the whole suite. A user on a supported LTS was told to go away.
  const guide = read('docs/remote-client-setup.md');
  const [major] = parseFloor(ENGINES);
  const claims = [...guide.matchAll(/Node ([^.\n]*?) will not start/g)].map((m) => m[1]);
  for (const claim of claims) {
    for (const tok of claim.split(/\s+or\s+|,| and /)) {
      const n = Number(tok.trim());
      if (Number.isFinite(n)) {
        assert.ok(n < major, `guide says Node ${n} will not start, but engines supports ${major}.x`);
      }
    }
  }
});

test('every CI matrix leg satisfies the declared floor (issue #222)', () => {
  // A leg below the floor cannot pass, and a leg that cannot pass is not a signal.
  const ci = read('.github/workflows/ci.yml');
  const legBlock = ci.match(/node-version:\s*\[([^\]]*)\]/)?.[1];
  assert.ok(legBlock, 'the CI workflow must declare a node-version matrix');
  const floor = parseFloor(ENGINES);
  const legs = legBlock.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.ok(legs.length > 0, 'the matrix must not be empty');
  for (const leg of legs) {
    const m = leg.match(/^(\d+)(?:\.(\d+|x))?/);
    assert.ok(m, `unparseable node-version leg ${leg}`);
    const minor = m[2] === undefined || m[2] === 'x' ? undefined : Number(m[2]);
    const v: [number, number] = [Number(m[1]), minor ?? 999];
    assert.ok(satisfies(v, floor), `CI tests node ${leg}, which does not satisfy engines ${ENGINES}`);
  }
});
