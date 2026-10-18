// The agent card (docs/a2a-design.md section 6.8).
//
// Two cards, deliberately different. The PUBLIC one is fetched before any credential exists, so it
// says only that this host speaks A2A and how to authenticate: name, one interface, the bearer
// scheme, capabilities and the required skill-selection extension. It lists NO skills. The
// EXTENDED card, behind authentication, lists exactly the skills the caller's owner may invoke.

import type { AgentCard, AgentCapabilities, AgentExtension, AgentInterface, AgentSkill, SecurityScheme } from '@a2a-js/sdk';
import { A2A_PREFIX, A2A_PROTOCOL_VERSION, A2A_SKILL_SELECTION_EXTENSION, type A2aConfig, type A2aExposedSkill } from './config.ts';

/** The card's security scheme name. Referenced by the interface's requirement and by clients. */
export const A2A_BEARER_SCHEME = 'mercuryBearer';

const BEARER: SecurityScheme = {
  scheme: {
    $case: 'httpAuthSecurityScheme',
    value: {
      description: 'Mercury API token (Authorization: Bearer <token>), resolved by the same resolver as every other Mercury surface.',
      scheme: 'Bearer',
      bearerFormat: 'opaque',
    },
  },
};

const SKILL_SELECTION_EXTENSION: AgentExtension = {
  uri: A2A_SKILL_SELECTION_EXTENSION,
  description: `Skill id is carried in SendMessageRequest.metadata.${'skillId'}; the request must declare this extension.`,
  // Required: a client that does not declare it is refused rather than served a guess (section 6.2).
  required: true,
  params: undefined,
};

function capabilities(): AgentCapabilities {
  return {
    // Both false until A2: streaming is A2, and push notifications are out of scope entirely
    // (section 6.6 answers PushNotificationNotSupportedError).
    streaming: false,
    pushNotifications: false,
    extensions: [SKILL_SELECTION_EXTENSION],
    // A1 serves the extended card; declaring it now is what lets a client ask for one.
    extendedAgentCard: true,
  };
}

function interfaces(config: A2aConfig): AgentInterface[] {
  return [{
    // The REST binding's base. The spec's URL patterns are appended to it by the SDK's handler.
    url: `${config.publicUrl}${A2A_PREFIX}`,
    protocolBinding: 'HTTP+JSON',
    tenant: '',
    protocolVersion: A2A_PROTOCOL_VERSION,
  }];
}

function toAgentSkill(skill: A2aExposedSkill): AgentSkill {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: [],
    // Deliberately empty: an example prompt is an operator's text, and a card is fetched by
    // callers the operator has not authenticated yet.
    examples: [],
    inputModes: ['text/plain'],
    outputModes: [],
    securityRequirements: [],
  };
}

export function buildPublicAgentCard(config: A2aConfig, version: string): AgentCard {
  return {
    name: config.name ?? 'Mercury',
    description: config.description ?? 'Mercury host: long-running coding Runs, exposed to A2A callers.',
    supportedInterfaces: interfaces(config),
    provider: undefined,
    version,
    capabilities: capabilities(),
    securitySchemes: { [A2A_BEARER_SCHEME]: BEARER },
    // Every interface on the card requires the bearer scheme. The public card is exempt from
    // AUTHENTICATION, not from declaring what authentication looks like.
    securityRequirements: [{ schemes: { [A2A_BEARER_SCHEME]: { list: [] } } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: [],
    // Empty on the public card, by section 6.8: an unauthenticated caller learns that the host
    // speaks A2A, not what work it accepts.
    skills: [],
    signatures: [],
  };
}

/** The caller's own view: the same card plus exactly the skills its owner may invoke. */
export function buildExtendedAgentCard(config: A2aConfig, version: string, skills: readonly A2aExposedSkill[]): AgentCard {
  return { ...buildPublicAgentCard(config, version), skills: skills.map(toAgentSkill) };
}
