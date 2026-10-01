/**
 * Asking, instead of guessing.
 *
 * `findMedication` is an exact lookup. Anything it does not recognise is told,
 * honestly, that it is not in the table and might still matter. That is the right
 * answer for a drug this genuinely does not know, and the wrong one for a drug it
 * knows perfectly well under a name that arrived slightly mangled.
 *
 * Drug names are the worst case for speech transcription there is. They are long,
 * they are not words, and several differ by one syllable while doing entirely
 * different things to a body in heat. "Lisinopril" blunts thirst; "liraglutide"
 * does not. Getting told "I don't have that in my list" because a microphone
 * heard one letter wrong loses advice the customer needed and had asked for.
 *
 * The protocol has had an answer to this since 2025-11-25. Elicitation lets the
 * server stop mid-tool-call and ask the host a structured question, and get a
 * typed answer back. Amazon's functional requirements ask for the behaviour in
 * as many words, twice: "prompt for missing required parameters", and "present
 * clarifying questions for ambiguous matches".
 *
 * The reason this is a module rather than three inline calls is that elicitation
 * is a *client* capability, and a server cannot assume it. Alexa+ may or may not
 * offer it; a script certainly will not; the test harness passes an object with
 * one method on it. So every path here has to degrade to the behaviour that
 * existed before, rather than throwing or hanging, and the call sites have to be
 * able to tell "the customer said Lot 12" from "nobody can be asked" without
 * either one reading like the other.
 *
 * Hence the three-way result. `chosen` is an answer. `unsupported` means carry on
 * exactly as before, because asking was never possible. `declined` means the
 * customer was asked and said no, which is not the same thing and must not be
 * quietly overridden by a guess.
 *
 * One rule specific to this product: a near match is never silently accepted. A
 * medication is only ever added because the customer confirmed the name, not
 * because an edit distance looked close enough. The whole point of asking is that
 * this server does not get to decide which drug somebody takes.
 */

/** Just enough of the server surface to ask a question, or to fail to. */
type Askable = {
  server?: {
    getClientCapabilities?: () => { elicitation?: unknown } | undefined;
    elicitInput?: (params: unknown) => Promise<{ action?: string; content?: Record<string, unknown> }>;
  };
};

export type Answer =
  | { kind: 'chosen'; value: string }
  | { kind: 'declined' }
  | { kind: 'unsupported' };

/**
 * Whether this host can be asked anything at all.
 *
 * Checked rather than attempted. Calling `elicitInput` on a client that never
 * declared the capability is a request that may sit unanswered until something
 * times out, and a voice turn has about half a second, so a hang is worse than
 * a guess.
 */
export function canAsk(server: unknown): boolean {
  const s = server as Askable;
  if (typeof s?.server?.elicitInput !== 'function') return false;
  const caps = s.server.getClientCapabilities?.();
  return caps?.elicitation != null;
}

/**
 * Ask the customer to pick one of a short list.
 *
 * An enum rather than free text, because the answer has to match something that
 * already exists: a field they registered, a machine they own. Free text would
 * put the matching problem straight back where it was.
 *
 * `titles` carries what to display; `values` is what comes back. They are kept
 * parallel rather than combined so the caller can hand back its own identifiers
 * and not have to re-resolve a spoken name a second time.
 */
export async function chooseOne(
  server: unknown,
  ask: { message: string; label: string; values: string[]; titles?: string[] },
): Promise<Answer> {
  if (!canAsk(server) || ask.values.length === 0) return { kind: 'unsupported' };
  const s = server as Askable;

  try {
    const result = await s.server!.elicitInput!({
      mode: 'form',
      message: ask.message,
      requestedSchema: {
        type: 'object',
        properties: {
          choice: {
            type: 'string',
            title: ask.label,
            enum: ask.values,
            // Titled enums arrived in this spec revision: the host shows these
            // and returns the matching value, so a display name never has to be
            // parsed back into an identifier.
            enumNames: ask.titles ?? ask.values,
          },
        },
        required: ['choice'],
      },
    });

    if (result?.action === 'accept') {
      const picked = result.content?.choice;
      // A host that accepts but returns something outside the enum is a host
      // that cannot be trusted with the answer. Treat it as never having asked
      // rather than acting on a value that was not offered.
      if (typeof picked === 'string' && ask.values.includes(picked)) {
        return { kind: 'chosen', value: picked };
      }
      return { kind: 'unsupported' };
    }

    // decline and cancel are both the customer saying no. They differ in intent
    // but not in what this server is allowed to do next, which is nothing.
    if (result?.action === 'decline' || result?.action === 'cancel') return { kind: 'declined' };
    return { kind: 'unsupported' };
  } catch {
    // A host that refuses, times out, or answers with something unparseable
    // leaves the tool exactly where it was before it asked.
    return { kind: 'unsupported' };
  }
}
