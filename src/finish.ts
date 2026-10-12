/**
 * The last thing done to every answer before it leaves: say nothing twice, and say what comes next.
 *
 * Measured across thirteen ordinary calls, the structured half of an answer was three times the size of the
 * spoken half, and most of the difference was repetition. A shortened answer carried its sentences three
 * times: as the text, again as `full`, and the leftover again as `more`. Notes that tools leave for the
 * shortening code (`mustSay`, `fullAnswer`, `offer`) went out to the host as if they were data. A host that
 * hands its model the structured half was reading every answer twice and paying for it in time.
 *
 * So `full` is dropped, because the text and `more` together are the whole answer, and the internal notes
 * are dropped, because the text already reflects them. `spoken` stays: it is the one field the declared
 * output schema promises, and a host that reads only structured data needs it.
 *
 * And every answer that has an obvious next step names it as `nextAction`, a tool and its arguments, so a
 * host can chain to it without having to work out the call from the sentence. Amazon's design guidance asks
 * for exactly this: the output of one tool should feed the next.
 */

type Result = { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Next = { tool: string; arguments: Record<string, unknown> } | null;

const INTERNAL = ['full', 'mustSay', 'fullAnswer', 'offer', 'sayFirst'];

/** What naturally follows each answer, or null. Only where there is one obvious step. */
export function nextFor(name: string, args: Record<string, unknown>, sc: Record<string, unknown>): Next {
  switch (name) {
    case 'register_location':
      return sc.status === 'ready' ? { tool: 'weather_check', arguments: {} } : null;
    case 'medication':
    case 'health_condition':
      // Something was added: the question it changes is whether it is safe outside.
      return sc.recognized === true && args.action !== 'remove' ? { tool: 'weather_check', arguments: {} } : null;
    case 'weather_check':
      // An official warning was just named: what to do about it is the next question.
      return typeof sc.warning === 'string' ? { tool: 'storm_prep', arguments: {} } : null;
    case 'plan_my_day': {
      const best = sc.best as { status?: string } | null | undefined;
      return best?.status === 'avoid' ? { tool: 'going_out_now', arguments: {} } : null;
    }
    case 'going_out_now':
      return typeof sc.nextStep === 'number' ? { tool: 'going_out_now', arguments: { step: sc.nextStep } } : null;
    // warning_signs points nowhere on purpose. A described emergency has already told the contacts, and
    // pointing at get_help from there sent the same people a second email a moment later.
    case 'log_outing':
      return args.felt === 'unwell' ? { tool: 'warning_signs', arguments: {} } : null;
    default:
      return null;
  }
}

export function finish(name: string, args: unknown, result: Result): Result {
  const sc = result?.structuredContent;
  if (!sc || result.isError) return result;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sc)) if (!INTERNAL.includes(k)) out[k] = v;
  // A tool that already named its next step knows better than this table does.
  if (out.nextAction === undefined) {
    const next = nextFor(name, (args ?? {}) as Record<string, unknown>, out);
    if (next) out.nextAction = next;
  }
  return { ...result, structuredContent: out };
}
