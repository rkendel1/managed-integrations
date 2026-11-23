/**
 * Maintenance planners. A planner decides which tool to call next; the toolbox owns authority,
 * policy and execution. Planners are replaceable.
 *
 *  - PlaybookPlanner: deterministic. Recognises known failure signatures (currently: GraphQL
 *    field removal) and applies a documented, mechanical repair. No model involved.
 *  - ClaudePlanner: Claude via the Messages API with a manual tool-use loop over the SAME
 *    restricted toolbox. Used when no playbook matches. Requires ANTHROPIC_API_KEY.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AGENT_EDITABLE_PREFIXES } from './policy.ts';
import { TOOL_DEFINITIONS, type MaintenanceToolbox } from './toolbox.ts';

export interface PlannerOutcome {
  outcome: 'candidate_submitted' | 'no_candidate';
  hypothesis: string;
  summary: string;
  cost: { modelInputTokens?: number; modelOutputTokens?: number; estimatedUsd?: number; modelCalls?: number };
}

export interface MaintenancePlanner {
  readonly name: 'playbook' | 'claude';
  run(toolbox: MaintenanceToolbox): Promise<PlannerOutcome>;
}

/* ===================================== Playbook ===================================== */

const FIELD_REMOVED = /Cannot query field "(\w+)" on type "(\w+)"/;

/** Parses `| Type | Removed field | Replacement field | ... |` tables from provider docs. */
export function parseFieldChanges(doc: string): { type: string; removed: string; replacement: string }[] {
  const out: { type: string; removed: string; replacement: string }[] = [];
  for (const line of doc.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 5) continue;
    const [, type, removed, replacement] = cells;
    if (!type || !removed || !replacement || /^-+$/.test(type) || type === 'Type') continue;
    if (/^\w+$/.test(type) && /^\w+$/.test(removed) && /^\w+$/.test(replacement)) out.push({ type, removed, replacement });
  }
  return out;
}

export class PlaybookPlanner implements MaintenancePlanner {
  readonly name = 'playbook' as const;

  async run(tb: MaintenanceToolbox): Promise<PlannerOutcome> {
    const none = (summary: string): PlannerOutcome => ({ outcome: 'no_candidate', hypothesis: summary, summary, cost: {} });

    await tb.invoke('read_incident');
    const obs = await tb.invoke('read_observations', { limit: 30 });
    const m = obs.match(FIELD_REMOVED);
    if (!m) return none('No known failure signature in observations; escalating to a human (or the Claude planner).');
    const [, field, type] = m as unknown as [string, string, string];

    // Reproduce: find the fixture profile whose behaviour matches the production observation.
    let reproProfile: string | null = null;
    for (const profile of ['baseline', 'drift']) {
      const r = await tb.invoke('run_tests', { target: 'acceptance', profile });
      if (r.startsWith('FAILED') && r.includes(`Cannot query field "${field}" on type "${type}"`)) {
        reproProfile = profile;
        break;
      }
    }
    if (!reproProfile) return none(`Could not reproduce "${field}" removal on ${type} in any fixture profile; escalating.`);

    const hits = await tb.invoke('search_source', { pattern: field, path: AGENT_EDITABLE_PREFIXES[0] });
    if (hits === 'No matches.') return none(`Field ${field} not referenced in the implementation; escalating.`);

    const index = await tb.invoke('read_provider_docs', {});
    let change: { type: string; removed: string; replacement: string } | undefined;
    for (const name of index.split('\n').filter((n) => n.endsWith('.md'))) {
      const doc = await tb.invoke('read_provider_docs', { name });
      change = parseFieldChanges(doc).find((c) => c.type === type && c.removed === field);
      if (change) break;
    }
    if (!change) return none(`Provider documentation names no replacement for ${type}.${field}; escalating to a human.`);

    const files = [...new Set(hits.split('\n').map((l) => l.split(':')[0]!).filter(Boolean))];
    for (const f of files) await tb.invoke('edit_file', { path: f, old: field, new: change.replacement, all: true });

    const testPath = `${AGENT_EDITABLE_PREFIXES[1]}${type.toLowerCase()}-${change.replacement}.test.ts`;
    await tb.invoke('write_file', {
      path: testPath,
      content: regressionTest(type, field, change.replacement),
    });

    const acc = await tb.invoke('run_tests', { target: 'acceptance', profile: reproProfile });
    const reg = await tb.invoke('run_tests', { target: 'regression', profile: reproProfile });
    const tc = await tb.invoke('run_tests', { target: 'typecheck', profile: reproProfile });
    if (!acc.startsWith('PASSED') || !reg.startsWith('PASSED') || !tc.startsWith('PASSED')) {
      return none('Mechanical field replacement did not pass the acceptance suite; escalating with diff attached.');
    }
    await tb.invoke('git_diff');
    const hypothesis =
      `Provider removed ${type}.${field} (GraphQL validation: Cannot query field "${field}" on type "${type}"). ` +
      `Provider documentation names ${change.replacement} as the replacement with the same MoneyBag shape. ` +
      `Reproduced with fixture profile "${reproProfile}". Repair: query and parse ${change.replacement} instead; ` +
      `mapping semantics (pre-discount unit price) unchanged. Added a regression test.`;
    const submitted = await tb.invoke('submit_candidate', { hypothesis });
    if (submitted.startsWith('ERROR')) return none(`Submission refused: ${submitted}`);
    return { outcome: 'candidate_submitted', hypothesis, summary: submitted, cost: {} };
  }
}

function regressionTest(type: string, removed: string, replacement: string): string {
  return `/**
 * Regression test added by the maintenance agent (playbook) for: ${type}.${removed} removed,
 * replaced by ${replacement}. Lives under test/regression (agent-editable); the authoritative
 * acceptance suite is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { ORDERS_QUERY, ORDER_BY_ID_QUERY, parseRawOrder } from '../../src/implementation/shopify-orders.ts';

describe('${type}.${removed} → ${replacement}', () => {
  it('no longer queries the removed field', () => {
    expect(ORDERS_QUERY).not.toMatch(/\\b${removed}\\b/);
    expect(ORDER_BY_ID_QUERY).not.toMatch(/\\b${removed}\\b/);
    expect(ORDERS_QUERY).toContain('${replacement}');
  });

  it('parses the unit price from ${replacement}', () => {
    const parsed = parseRawOrder({
      id: 'gid://shopify/Order/1',
      legacyResourceId: '1',
      name: '#1',
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      cancelledAt: null,
      currencyCode: 'USD',
      email: null,
      totalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } },
      lineItems: { nodes: [{ sku: 'A', title: 'A', quantity: 2, ${replacement}: { shopMoney: { amount: '5.00', currencyCode: 'USD' } } }], pageInfo: { hasNextPage: false } },
    } as never);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.order.lineItems[0]!.unitPrice).toBe('5.00');
  });
});
`;
}

/* ===================================== Claude ===================================== */

const SYSTEM_PROMPT = `You are an internal maintenance engineer for a managed Shopify → NetSuite integration.
A production integration failed and deterministic recovery could not fix it. Your job is to produce a
repair candidate for human review, using only the provided tools inside an isolated repair worktree.

Rules that the tools enforce (do not try to work around them):
- You may edit only: ${AGENT_EDITABLE_PREFIXES.join(', ')}.
- The acceptance suite, fixtures, contracts and engine are protected. Never weaken tests.
- You cannot access credentials, production data, or deploy anything. A human approves releases.

Process: read the incident and observations, form a hypothesis, reproduce the failure with run_tests
(try the available fixture profiles), consult read_provider_docs, make the smallest change in the
implementation, add a regression test under test/regression, run acceptance + regression + typecheck
for the reproducing profile, inspect git_diff, then call submit_candidate with a precise hypothesis.
If you cannot produce a passing, minimal fix, stop and explain why instead of submitting.`;

/** Estimated list price for claude-opus-5-5 ($/MTok), used only for cost reporting. */
const PRICE = { input: 4, output: 20 };

export class ClaudePlanner implements MaintenancePlanner {
  readonly name = 'claude' as const;
  private readonly client: Anthropic;

  constructor(
    private readonly opts: { model?: string; maxTurns?: number; client?: Anthropic } = {},
  ) {
    this.client = opts.client ?? new Anthropic();
  }

  async run(tb: MaintenanceToolbox): Promise<PlannerOutcome> {
    const tools: Anthropic.Beta.BetaTool[] = TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object' as const,
        properties: Object.fromEntries(Object.keys(t.input).map((k) => [k, { type: k === 'limit' ? 'number' : k === 'all' ? 'boolean' : 'string' }])),
      },
    }));
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: 'Investigate the incident and, if possible, submit a repair candidate.' },
    ];
    let inputTokens = 0;
    let outputTokens = 0;
    let calls = 0;
    let finalText = '';
    for (let turn = 0; turn < (this.opts.maxTurns ?? 40); turn++) {
      const response = await this.client.beta.messages.create({
        model: this.opts.model ?? process.env.MAINTENANCE_MODEL ?? 'claude-opus-5-5',
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools,
        messages,
        output_config: { effort: 'high' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      } as Anthropic.Beta.MessageCreateParamsNonStreaming);
      calls++;
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      finalText = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n');
      if (response.stop_reason === 'refusal' || response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') break;
      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason === 'pause_turn') continue;
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const out = await tb.invoke(block.name, (block.input ?? {}) as Record<string, unknown>);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out.slice(0, 20_000), ...(out.startsWith('ERROR') ? { is_error: true } : {}) });
      }
      if (!results.length) break;
      messages.push({ role: 'user', content: results });
      if (tb.submittedCandidateId) break;
    }
    const cost = {
      modelInputTokens: inputTokens,
      modelOutputTokens: outputTokens,
      modelCalls: calls,
      estimatedUsd: Number(((inputTokens * PRICE.input + outputTokens * PRICE.output) / 1_000_000).toFixed(4)),
    };
    const hypothesis = finalText.slice(0, 4000) || 'No explanation returned.';
    return tb.submittedCandidateId
      ? { outcome: 'candidate_submitted', hypothesis, summary: `Candidate ${tb.submittedCandidateId} submitted`, cost }
      : { outcome: 'no_candidate', hypothesis, summary: 'Planner stopped without submitting a candidate.', cost };
  }
}
