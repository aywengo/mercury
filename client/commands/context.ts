// Shared command setup: resolve configuration, then a credential, then a client.
//
// Kept in one place so no command can forget a step -- in particular so no command can construct a
// transport that skips the credential permission check or the endpoint policy.

import { resolveConfig } from '../config.ts';
import type { ResolveOptions } from '../config.ts';
import { resolveCredential } from '../credentials.ts';
import { MercuryClient } from '../api/client.ts';
import type { GlobalOptions } from '../cli.ts';

export interface CommandContext {
  client: MercuryClient;
  profileName: string;
  json: boolean;
  noColor: boolean;
}

export function buildContext(globals: GlobalOptions, resolve: ResolveOptions = {}): CommandContext {
  const config = resolveConfig({
    ...resolve,
    profileFlag: globals.profile,
    urlFlag: globals.url,
    timeoutFlagMs: globals.timeoutMs,
    noColorFlag: globals.noColor,
  });
  const credential = resolveCredential({
    credentialName: config.credentialName,
    env: resolve.env,
    dir: resolve.dir,
  });
  return {
    client: new MercuryClient({
      baseUrl: config.url,
      token: credential.token,
      timeoutMs: config.timeoutMs,
      caFile: config.caFile,
    }),
    profileName: config.profileName,
    json: globals.json,
    noColor: globals.noColor,
  };
}
