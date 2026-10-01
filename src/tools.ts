import { z } from 'zod';
/**
 * Every tool this add-on publishes, grouped by what it is for.
 *
 * This file used to be 1,386 lines with eighteen tools inside one function. The
 * tools are the same; they now live in one file per job, and this is the index.
 *
 * Registration order is deliberate. A host reads `tools/list` in the order the
 * server declares them, and this order is roughly the order a person meets them:
 * say who you are, say who to tell, then the record, then the conditions, then
 * the judgement built on top of them. `warning_signs` and the first aid it leads
 * to sit inside the judgement group rather than off on their own, because the
 * whole point is that they are reachable from the same conversation as "when
 * should I go out" and not filed somewhere a frightened person has to find.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as profile from './tools/profile.js';
import * as contact from './tools/contact.js';
import * as outings from './tools/outings.js';
import * as conditions_raw from './tools/conditions_raw.js';
import * as plan from './tools/plan.js';
import * as shovel from './tools/shovel.js';
import * as refuge from './tools/refuge.js';
import * as official from './tools/official.js';
import * as skin from './tools/skin.js';
import * as discovery from './tools/discovery.js';

// Re-exported because server.ts imports it from here, and moving it to
// shared.ts should not make every caller learn the new layout.
export { resolveLocation } from './tools/shared.js';

/**
 * What every answer from this server contains, declared so a host can rely on it.
 *
 * Alexa+'s functional requirements ask for "well-formed responses that conform to your declared schema", and
 * a tool that publishes no outputSchema gives a host nothing to check. The schema is deliberately loose
 * about the rest: each tool adds its own fields (a verdict, a window, the next step) and those stay free to
 * grow, so only the part that is true of every answer is promised, which is the sentence to say aloud.
 */
const SPOKEN_ANSWER = z.object({ spoken: z.string().describe('The answer to say aloud, as written') }).passthrough();

export function registerTools(server: McpServer, personOf: () => string): void {
  // Declare the output schema once, here, rather than on every tool in every file, so a tool added later
  // cannot be the one that forgets. A tool that sets its own outputSchema keeps it.
  const registerTool = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: unknown) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (name: string, config: Record<string, unknown>, cb: unknown) =>
    registerTool(name, { outputSchema: SPOKEN_ANSWER, ...config }, cb);
  profile.register(server, personOf);
  contact.register(server, personOf);
  outings.register(server, personOf);
  conditions_raw.register(server, personOf);
  plan.register(server, personOf);
  shovel.register(server, personOf);
  refuge.register(server, personOf);
  official.register(server, personOf);
  skin.register(server, personOf);
  discovery.register(server, personOf);
}
