import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * A refusal in words a person can act on, instead of the protocol's own.
 *
 * When arguments do not match a tool's schema, the SDK answers with its own
 * sentence: "MCP error -32602: Input validation error: Invalid arguments for
 * tool can_i_run: Invalid enum value. Expected 'planting' | 'tillage'...".
 * That text is what the host reads, and Amazon's functional requirements are
 * explicit that no API codes, tool names or JSON reach a customer-facing
 * response, and that every error carries an actionable next step. The MCP
 * specification agrees: it files input validation errors under tool execution
 * errors, which "contain actionable feedback that language models can use to
 * self-correct", not under protocol errors. So the tools/call handler is
 * wrapped and those two cases are put back into English:
 * a word we did not recognise, where the choices are worth offering, and
 * anything else, where the honest answer is that the detail did not arrive.
 *
 * Five choices at most, because the voice requirements cap spoken options at
 * five. If the SDK ever stops reporting errors this way, the wrapper simply
 * finds nothing to rewrite, and test-contract.mjs is what notices.
 */
function plainly(message: string): string {
  // Only the part before "received": the word that was rejected is in the same
  // message, and offering it back as a choice is worse than saying nothing. The
  // options are spoken, so an id like strip_till has to lose its underscore.
  const expectedPart = message.split(/,\s*received/)[0];
  const options = [...expectedPart.matchAll(/'([a-z_]{2,})'/g)].map((m) => m[1].replace(/_/g, ' '));
  const expected = /Invalid enum value|Invalid literal/.test(message) && options.length > 1;
  if (expected) {
    const few = options.slice(0, 5).join(', ');
    return `I didn't catch which one you meant. I can do ${few}${options.length > 5 ? ', and a few more' : ''}. Which is it?`;
  }
  if (/not found/i.test(message)) {
    return "I can't do that one. Ask me what I can do and I'll tell you what I have.";
  }
  return "I didn't get one of the details I need for that. Tell me again in your own words and I'll have another go.";
}

/** Swap the protocol's error text for that, leaving every other answer alone. */
export function speakErrorsPlainly(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, Function> })._requestHandlers;
  const inner = handlers?.get('tools/call');
  if (!handlers || !inner) return;
  handlers.set('tools/call', async (request: unknown, extra: unknown) => {
    const result = (await inner(request, extra)) as { isError?: boolean; content?: { type: string; text?: string }[] };
    const spoken = result?.content?.[0]?.text;
    if (result?.isError && typeof spoken === 'string' && /^MCP error/.test(spoken)) {
      return { ...result, content: [{ type: 'text', text: plainly(spoken) }] };
    }
    return result;
  });
}
