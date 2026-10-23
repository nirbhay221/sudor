/**
 * The two routes the demo page uses beside MCP: the Alexa+ stand-in, which has a model (or the word
 * rules) choose a tool from the real tools/list and calls it over MCP, and speech for the answers.
 */

import type express from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chooseByWords } from './rules.js';
import { requireAuth } from './auth.js';
import * as agent from './agent.js';
import * as speak from './speak.js';
import * as store from './store.js';
import { dailyCap, perCaller, periodCap } from './budget.js';
import * as nvidia from './nvidia.js';
import { callerKey, personFrom } from './caller.js';

/**
 * Carried in every stand-in response, so the disclaimer travels with the data
 * rather than living in a README. This is a model playing the part Alexa+ would
 * play; it does not share Alexa's prompt, its turn budget, or its judgment about
 * when to call something.
 */
const STAND_IN_NOTE =
  "Alexa+ stand-in: a model reading this server's real tools/list and calling it over MCP. Not Alexa.";

/**
 * What the paid endpoints are allowed to cost. See budget.ts for why there are two
 * kinds of limit and what each one is for.
 *
 * A model call is a few cents; 300 a day is roughly the price of a coffee and is far
 * more than a judge clicking through a demo will use. Speech is metered in characters
 * because that is what Polly bills, and a cache hit is free, so the same six canned
 * answers replayed all day cost six syntheses.
 */
const agentDaily = dailyCap(Number(process.env.SUDOR_AGENT_DAILY_MAX ?? 150));
const speakDaily = dailyCap(Number(process.env.SUDOR_SPEAK_DAILY_CHARS ?? 100_000));
// The backup model, NVIDIA's, for when Claude cannot answer: so many calls per ten days, not per day. See nvidia.ts.
const backupWindow = periodCap(Number(process.env.SUDOR_NVIDIA_MAX ?? 150), Number(process.env.SUDOR_NVIDIA_PERIOD_DAYS ?? 10) * 86_400_000);
/** For /health: what is left of today's spend on each. */
export const budgetStatus = () => ({ agent: agentDaily.status(), backup: backupWindow.status(), speechCharacters: speakDaily.status() });
// Burst and sustained rate per caller. A person typing into the stand-in does not
// send six requests a minute; the defaults are for people and the knobs are for tests
// and for an operator who has a reason.
const agentPerCaller = perCaller(Number(process.env.SUDOR_AGENT_BURST ?? 3), Number(process.env.SUDOR_AGENT_PER_MINUTE ?? 6));
const speakPerCaller = perCaller(Number(process.env.SUDOR_SPEAK_BURST ?? 5), Number(process.env.SUDOR_SPEAK_PER_MINUTE ?? 20));

/** The page's earlier turns, cleaned: only user and assistant text, last six, alternating, starting with the user. */
export function conversation(raw: unknown): agent.Turn[] {
  if (!Array.isArray(raw)) return [];
  const turns = raw
    .filter((t): t is { role: string; text: string } => !!t && typeof t === 'object' && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string')
    .map((t) => ({ role: t.role as 'user' | 'assistant', text: t.text.slice(0, 500).trim() }))
    .filter((t) => t.text)
    .slice(-6);
  // Alternating, and the last must be the add-on's answer so the new sentence follows it.
  const out: agent.Turn[] = [];
  for (const t of turns) if (!out.length ? t.role === 'user' : t.role !== out[out.length - 1].role) out.push(t);
  while (out.length && out[out.length - 1].role !== 'assistant') out.pop();
  return out;
}

export function mountStandIn(app: express.Express, build: (personId: string) => McpServer): void {
  /**
   * The Alexa+ stand-in.
   *
   * A model reads this server's own `tools/list` cold, decides what the sentence
   * means, and the chosen call is executed through the real protocol. Both halves
   * are returned, so a viewer sees the decision and not only the answer, which is
   * the point: the decision is what a real host would have had to make from the
   * tool descriptions alone.
   *
   * The round trip goes through an in-memory MCP transport rather than calling the
   * tool handlers directly. That costs a few milliseconds and buys the thing that
   * makes the demo worth anything: the schemas the model reads are the schemas the
   * protocol publishes, and the call it makes is validated and dispatched exactly
   * as a real host's would be.
   *
   * Nothing the model says is stored, and nothing it chooses is executed outside
   * this request. What the tools themselves write, they write for the same person
   * the request is scoped to, exactly as an Alexa+ call would.
   */
  app.post('/agent', requireAuth, async (req, res) => {
    // Identity and spend are checked before anything else, including whether the
    // stand-in is configured, so an unconfigured server cannot be used to find out
    // which of the two a caller failed.
    if (!agentPerCaller.allow(callerKey(req))) {
      res.status(429).set('Retry-After', '10').json({ error: 'slow_down', detail: 'Too many stand-in requests. Try again in a few seconds.' });
      return;
    }
    const utterance = typeof req.body?.say === 'string' ? req.body.say.slice(0, 500).trim() : '';
    if (!utterance) {
      res.status(400).json({ error: 'say_required' });
      return;
    }
    /*
     * The turns before this one, as the page kept them. Alexa+ holds the conversation, not the add-on: "Alexa
     * handles conversation continuity" and understands "references to earlier turns in the session" (Amazon's
     * conversation surface guide). A stand-in that saw one sentence at a time could not tell what a plain "no"
     * answered, and every setup question ends on one. Kept short: the last six turns, 500 characters each,
     * alternating, starting with the customer, as the Messages API requires.
     *   https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-conversation-surface.html
     */
    const history = conversation(req.body?.history);
    // Last, so a malformed request never spends a unit of the budget.
    // No model configured, or today's model budget spent: the word rules choose instead, and say so. See rules.ts.
    const useModel = agent.configured() && agentDaily.take(1);

    const who = personFrom(req);
    // A write made elsewhere, such as an alert the scheduled check sent. A no-op for the file store.
    await store.refresh(who).catch((err) => console.error('[store] refresh failed:', err instanceof Error ? err.message : err));
    const server = build(who);
    const client = new Client({ name: 'alexa-plus-stand-in', version: '0.1.0' }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(a), client.connect(b)]);
      const listed = await client.listTools();
      const tools = listed.tools as (agent.ToolDef & { annotations?: { readOnlyHint?: boolean } })[];
      // The next step the last answer named, as the page kept it; only ever a tool this server lists.
      const nextRaw = req.body?.next as { tool?: unknown; arguments?: unknown } | undefined;
      const next = nextRaw && typeof nextRaw.tool === 'string' && tools.some((t) => t.name === nextRaw.tool) ? nextRaw : null;
      const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<agent.CallResult>;
      // The model refusing (a spend limit reached, a key revoked, the API down) used to show the visitor "the
      // stand-in request was refused". The word rules answer instead, as they do when the day's budget is spent,
      // and the reason is kept for the page. Only the model's own errors fall through; a tool failing is still one.
      let modelError: string | null = null;
      if (useModel) {
        try {
          const turn = await agent.converse(utterance, tools, client.getInstructions() ?? '', history, call, () => agentDaily.take(1));
          const last = turn.steps[turn.steps.length - 1];
          res.json({
            standIn: STAND_IN_NOTE, utterance,
            chose: turn.steps[0] ? { tool: turn.steps[0].tool, args: turn.steps[0].args } : null,
            steps: turn.steps.map((s) => ({ tool: s.tool, args: s.args })),
            said: turn.reply, reply: turn.reply, ms: turn.ms, model: turn.model, calls: turn.calls,
            ...(last ? { result: last.result } : {}),
          });
          return;
        } catch (err) {
          if (!agent.isModelError(err)) throw err;
          modelError = agent.explainError(err);
          console.error('[agent] the model refused, so the word rules answer:', modelError);
        }
      }
      // Claude did not answer (no key, the day's budget spent, or refused): NVIDIA's model chooses, while its ten-day
      // allowance lasts. It only picks the tool; the tool's own answer is what is said. Anything else, the word rules.
      if (nvidia.configured() && backupWindow.take(1)) {
        try {
          const backup = await nvidia.choose(utterance, tools, client.getInstructions() ?? '', history, agent.SYSTEM);
          if (backup?.tool) {
            const result = await client.callTool({ name: backup.tool, arguments: backup.args });
            if (!result.isError) {
              const reply = (result.content as { text?: string }[] | undefined)?.map((c) => c.text ?? '').join(' ').trim() ?? '';
              res.json({
                standIn: STAND_IN_NOTE, utterance,
                chose: { tool: backup.tool, args: backup.args },
                steps: [{ tool: backup.tool, args: backup.args }],
                said: '', reply, ms: backup.ms, model: backup.model, result, ...(modelError ? { modelError } : {}),
              });
              return;
            }
          }
        } catch (err) {
          console.error('[agent] the backup model failed, so the word rules answer:', err instanceof Error ? err.message : err);
        }
      }
      const chosen = chooseByWords(utterance, tools, history, next);

      // A decline is a real outcome. A host that calls nothing when nothing fits is
      // behaving correctly, and flattening that into an error would hide it.
      if (!chosen.tool) {
        res.json({ standIn: STAND_IN_NOTE, utterance, chose: null, said: chosen.said, ms: chosen.ms, model: chosen.model, ...(modelError ? { modelError } : {}) });
        return;
      }

      const result = await client.callTool({ name: chosen.tool, arguments: chosen.args });
      const reply = (result.content as { text?: string }[] | undefined)?.map((c) => c.text ?? '').join(' ').trim() ?? '';
      res.json({
        standIn: STAND_IN_NOTE, utterance,
        chose: { tool: chosen.tool, args: chosen.args },
        steps: [{ tool: chosen.tool, args: chosen.args }],
        said: chosen.said, reply, ms: chosen.ms, model: chosen.model, result, ...(modelError ? { modelError } : {}),
      });
    } catch (err) {
      console.error('[agent]', err);
      res.status(502).json({ error: 'stand_in_failed', detail: agent.explainError(err) });
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  /**
   * Speak a sentence this server produced.
   *
   * For the demo page and the video only; it is not part of the MCP path, because
   * Alexa+ does its own speech. The point is narrow and it matters here: the
   * emergency phrasing has to land at the speed of speech, once, to somebody who is
   * frightened, and a page of text cannot show whether it does.
   */
  app.post('/speak', requireAuth, async (req, res) => {
    if (!speakPerCaller.allow(callerKey(req))) {
      res.status(429).set('Retry-After', '5').json({ error: 'slow_down' });
      return;
    }
    if (!speak.SPEAK_ON) {
      res.status(503).json({
        error: 'not_enabled',
        detail: 'Set SUDOR_SPEAK=on to enable spoken answers. The page works as text without it.',
      });
      return;
    }
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!speak.usable(text.trim().replace(/\s+/g, ' '))) {
      res.status(400).json({ error: 'not_speakable' });
      return;
    }
    // Characters are what Polly bills, and a sentence already held costs nothing, so
    // only a synthesis is charged against the day.
    if (!speak.isCached(text) && !speakDaily.take(text.trim().length)) {
      res.status(429).json({ error: 'daily_budget', detail: 'Spoken answers have reached their limit for today.' });
      return;
    }
    try {
      const out = await speak.speak(text);
      res.setHeader('content-type', 'audio/mpeg');
      // Cached by content hash server side; let the browser hold it too, since the
      // same canned answers are replayed constantly during a demo.
      res.setHeader('cache-control', 'public, max-age=3600');
      res.setHeader('x-sudor-cached', out.cached ? '1' : '0');
      res.send(Buffer.from(out.audio));
    } catch (err) {
      console.error('[speak]', err);
      res.status(502).json({ error: 'speak_failed' });
    }
  });
}
