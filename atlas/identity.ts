/**
 * Repository identity (docs/knowledge-base.md section 5).
 *
 * This is a deliberate second copy: the host has the same function in `src/knowledge/identity.ts`,
 * and Atlas may not import it (section 11.6 -- the coupling rule Fleet lives under too). The two are
 * held in agreement by a shared table of vectors in `test/atlasContract.test.ts`, which feeds the
 * same inputs to both and asserts the same outputs.
 *
 * Why not a shared module instead? Because this function decides **which project a note lands in**.
 * A silent divergence would not crash anything; it would file one host's knowledge into another
 * project's base, which is the failure section 5 opens by naming. A test that runs both
 * implementations against the same vectors catches that, and keeps the boundary enforceable, which a
 * shared import would quietly remove.
 *
 * Normalization is mechanical and identical on both sides:
 *
 *   1. Parse the URL; accept `https://`, `ssh://`, and the `git@host:org/repo` scp form.
 *   2. Drop credentials, port defaults, query and fragment.
 *   3. Lowercase the host. Keep the path case as given -- some forges are case-sensitive.
 *   4. Strip a trailing `.git` and a trailing `/`.
 *   5. Identity is `host/path`; the identity hash is the hex SHA-256 of that string, to 16 chars.
 */

import { createHash } from 'node:crypto';
import { isAbsolute, resolve as resolvePath } from 'node:path';

/** Length of the truncated hash used in scope keys (`repo:<hash>`). */
export const IDENTITY_HASH_LENGTH = 16;

/** Ports that mean "the default for this scheme" and so carry no information (step 2). */
const DEFAULT_PORTS: Record<string, string> = { 'https:': '443', 'http:': '80', 'ssh:': '22', 'git:': '9418' };

/**
 * The scp form, `git@host:org/repo.git`, which is not a URL: it has no scheme, and its first `:`
 * separates host from path rather than host from port.
 *
 * Built from a string rather than a regex literal so the `/` characters inside it need no escaping
 * -- a `/` inside a `/.../ ` literal is a trap that reads fine and matches nothing.
 *
 * The user part is optional because `host:org/repo` also appears. The path must contain a `/`,
 * which is what distinguishes this from a bare hostname and from a Windows drive letter.
 */
const SCP_FORM = new RegExp('^(?:[^@/]+@)?([A-Za-z0-9._-]+):([^/].*/.*)$');

export interface RepoIdentity {
  /** `host/path`, or `file/<absolute path>` for a local checkout. */
  identity: string;
  /** The 16-char hash that appears in a scope key. */
  hash: string;
  /** True for a local filesystem path, which can never match another host's identity. */
  local: boolean;
}

/**
 * Strip leading and trailing separators, a trailing `.git`, and collapse doubled separators.
 *
 * Plain string operations rather than regex: every one of these patterns involves a `/`, and a
 * mis-escaped `/` inside a regex literal is a syntax error at best and a silent non-match at worst.
 */
function cleanPath(path: string): string {
  let p = path;
  while (p.startsWith('/')) p = p.slice(1);
  while (p.endsWith('/')) p = p.slice(0, -1);
  if (p.toLowerCase().endsWith('.git')) p = p.slice(0, -4);
  while (p.includes('//')) p = p.split('//').join('/');
  return p;
}

/**
 * Remove `.` and `..` segments, the way RFC 3986 §5.24 does for a URL path.
 *
 * Mirrors src/knowledge/identity.ts exactly. `new URL()` already does this to every path it parses, so
 * the URL branch never sees a dot segment; the scp form is not parsed by `new URL()` at all, which is
 * why it needs its own branch and why it has to do the same work here.
 *
 * A `..` that would climb above the first segment is dropped: there is no meaningful identity above the
 * owner, and keeping one produced a scope no other host could ever report.
 */
function collapseDotSegments(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/**
 * Normalize one repository reference to its identity string.
 *
 * Returns null only for input that is not a repository reference at all. Callers treat null as
 * "this Run contributes nothing", never as an error: section 5 is explicit that a Run against an
 * unrelated repository is legitimate and should simply be outside the knowledge base rather than
 * inside the wrong one.
 */
export function normalizeRepoIdentity(raw: string): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;

  // A local checkout, normalized as `file/<absolute path>` and explicitly host-local: two hosts
  // with the same path on disk are NOT the same repository, and treating them as one would let a
  // laptop contribute to a CI host's project by coincidence.
  const looksLocal = isAbsolute(trimmed) || trimmed === '.' || trimmed === '~'
    || trimmed.startsWith('~/') || trimmed.startsWith('./') || trimmed.startsWith('../');
  if (looksLocal) {
    const abs = trimmed.startsWith('~')
      ? resolvePath(process.env.HOME ?? '/', trimmed.slice(2))
      : resolvePath(trimmed);
    // `file/` plus the path with its leading separator removed, so an identity never contains `//`.
    // Section 5 writes this as `file/<absolute path>`, which read literally yields the double
    // separator; collapsing it keeps `identity` a single host/path token.
    return 'file/' + abs.replace(/^\/+/, '');
  }

  // The scp form must be tried before the URL parser: `new URL('git@github.com:a/b.git')` throws,
  // and the obvious fix of prefixing `ssh://` makes the parser read `a` as a hostname.
  if (!trimmed.includes('://')) {
    const scp = SCP_FORM.exec(trimmed);
    if (scp) {
      const host = scp[1]!.toLowerCase();
      // Kept byte-for-byte equivalent to src/knowledge/identity.ts. The two copies are deliberately
      // independent (Atlas and a host must not share a module they can each change), and
      // atlasAgreement.test.ts is what holds them together. Dot segments have to be collapsed here too:
      // the URL branch gets it free from `new URL()` and this branch does not, so a host that spells the
      // repository in scp form and a host that spells it as a URL would otherwise file the same
      // convention into two different scopes.
      const path = collapseDotSegments(cleanPath(scp[2]!));
      return path ? `${host}/${path}` : null;
    }
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!(url.protocol in DEFAULT_PORTS)) return null;

  // Step 3: host case is not significant in DNS. `hostname` excludes the port.
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  // A non-default port is kept, as `host:port/path`. Dropping it would merge two servers that
  // genuinely serve different repositories, which is the opposite of what an identity is for.
  const port = url.port && url.port !== DEFAULT_PORTS[url.protocol] ? `:${url.port}` : '';

  // Step 2: credentials live in `username`/`password`, query and fragment in `search`/`hash`. None
  // of them is read, which is how they are dropped.
  const path = cleanPath(url.pathname);
  if (!path) return null;
  return `${host}${port}/${path}`;
}

/** The identity hash that appears in a scope key as `repo:<hash>`. */
export function identityHash(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, IDENTITY_HASH_LENGTH);
}

/** Identity and hash in one pass, which is what the harvester and pack selection both want. */
export function repoIdentity(raw: string): RepoIdentity | null {
  const identity = normalizeRepoIdentity(raw);
  if (!identity) return null;
  return { identity, hash: identityHash(identity), local: identity.startsWith('file/') };
}
