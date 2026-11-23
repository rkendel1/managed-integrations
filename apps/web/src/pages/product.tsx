/**
 * The customer product (slice 4): what we maintain, whether it is protected, what we did, and what it
 * meant for the customer's orders. Rendered only from AppPort capabilities (portfolio.list,
 * portfolio.integration, maintenance.events.get) — the same ones MCP exposes. Operators see the same
 * event projection plus the evidence behind it (maintenance.events.evidence).
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { Card, CardBody, CardHeader, Empty, ErrorNote, StatusBadge, Table, Td } from '@/components/ui';
import { callCapability } from '@/lib/capabilities';
import { fmtDate } from '@/lib/utils';

interface Status {
  code: 'protected' | 'maintaining' | 'verified' | 'customer_action' | 'checking';
  label: string;
  definition: string;
  reason: string;
}
interface IntegrationCard {
  id: string;
  name: string;
  process: string;
  status: Status;
  lastVerified: { at: string; ordersChecked: number; statement: string } | null;
  openIssues: number;
  customerActions: string[];
}
interface EventSummary {
  id: string;
  category: string;
  state: 'in_progress' | 'completed' | 'needs_you';
  headline: string;
  detectedAt: string;
  resolvedAt: string | null;
  zeroLoss: boolean;
}
interface CustomerEvent extends Omit<EventSummary, 'zeroLoss'> {
  integrationId: string;
  summary: string;
  facts: { label: string; value: string }[];
  accounting: {
    window: { from: string; to: string };
    ordersInWindow: number;
    deliveredBeforeChange: number;
    delayed: number;
    failedDuringDisruption: number;
    foundByChecking: number;
    recovered: number;
    verified: number;
    excluded: number;
    unresolved: number;
    duplicates: number;
  } | null;
  claim: { zeroLoss: boolean; statement: string | null; basis: string };
  customerAction: { required: boolean; text: string | null };
  timeline: { at: string; text: string }[];
}

const STATUS_STYLE: Record<Status['code'], string> = {
  protected: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  verified: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  maintaining: 'bg-sky-50 text-sky-800 ring-sky-200',
  customer_action: 'bg-amber-50 text-amber-900 ring-amber-200',
  checking: 'bg-slate-50 text-slate-700 ring-slate-200',
};
const STATUS_DOT: Record<Status['code'], string> = {
  protected: 'bg-emerald-500',
  verified: 'bg-emerald-500',
  maintaining: 'bg-sky-500',
  customer_action: 'bg-amber-500',
  checking: 'bg-slate-400',
};

function StatusPill({ status }: { status: Status }) {
  return (
    <span
      data-testid="product-status"
      data-status={status.code}
      title={status.definition}
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ring-1 ${STATUS_STYLE[status.code]}`}
    >
      <span className={`h-2 w-2 rounded-full ${STATUS_DOT[status.code]}`} />
      {status.label}
    </span>
  );
}

const useCapability = <T,>(name: string, input: unknown, key: unknown[]) =>
  useQuery({ queryKey: ['appport', name, ...key], queryFn: () => callCapability<T>(name, input) });

/* ================================================================== portfolio */

export function Portfolio() {
  const q = useCapability<{ tenant: { name: string }; integrations: IntegrationCard[] }>(
    'portfolio.list',
    {},
    [],
  );
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return null;
  return (
    <>
      <section className="rounded-xl bg-slate-900 px-6 py-8 text-white">
        <p className="text-sm text-slate-300">{q.data.tenant.name}</p>
        <h1 className="mt-1 text-2xl font-semibold">We keep your integrations working.</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-300">
          When something changes, we take care of it, verify the outcome against your systems, and tell you
          what happened. We only ask you when a decision is yours.
        </p>
      </section>
      {q.data.integrations.length === 0 ? (
        <Empty>No integrations are entrusted to us yet.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2" data-testid="portfolio">
          {q.data.integrations.map((i) => (
            <Card key={i.id} data-testid="portfolio-integration">
              <CardBody className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-lg font-semibold">{i.name}</p>
                    <p className="text-sm text-slate-500">{i.process}</p>
                  </div>
                  <StatusPill status={i.status} />
                </div>
                <p className="text-sm text-slate-700" data-testid="status-reason">
                  {i.status.reason}
                </p>
                <p className="text-xs text-slate-500">{i.status.definition}</p>
                {i.customerActions.length ? (
                  <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="actions">
                    <p className="font-medium">We need you</p>
                    <ul className="mt-1 list-disc pl-5">
                      {i.customerActions.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <Link
                  className="inline-block text-sm font-medium text-slate-900 underline"
                  to={`/app/integrations/${i.id}`}
                >
                  View details
                </Link>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

/* ================================================================== integration */

export function IntegrationDetail({ eventBase = '/app/maintenance' }: { eventBase?: string }) {
  const { integrationId } = useParams();
  const q = useCapability<IntegrationCard & { responsibilities: string[]; maintenance: EventSummary[] }>(
    'portfolio.integration',
    { integrationId },
    [integrationId],
  );
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data;
  if (!d) return null;
  return (
    <>
      <Card data-testid="integration-detail">
        <CardHeader title={d.name} description={d.process} actions={<StatusPill status={d.status} />} />
        <CardBody className="space-y-2 text-sm">
          <p>{d.status.reason}</p>
          <p className="text-xs text-slate-500">
            <span className="font-medium">{d.status.label}:</span> {d.status.definition}
          </p>
          {d.customerActions.length ? (
            <div className="rounded-lg bg-amber-50 p-3 text-amber-900" data-testid="actions">
              {d.customerActions.map((a) => (
                <p key={a}>{a}</p>
              ))}
            </div>
          ) : (
            <p className="text-slate-600">Nothing is needed from you.</p>
          )}
        </CardBody>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="What we are responsible for" />
          <CardBody>
            <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="responsibilities">
              {d.responsibilities.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Last verified outcome" />
          <CardBody className="text-sm" data-testid="last-verified">
            {d.lastVerified
              ? d.lastVerified.statement
              : 'No completed check that accounts for every order yet.'}
          </CardBody>
        </Card>
      </div>
      <Card data-testid="maintenance-history">
        <CardHeader title="Maintenance" description="Changes and issues we handled for this integration." />
        <CardBody>
          {d.maintenance.length === 0 ? (
            <Empty>Nothing has needed maintenance yet.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {d.maintenance.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-3 py-3"
                  data-testid="maintenance-row"
                  data-state={m.state}
                >
                  <div>
                    <Link className="font-medium underline" to={`${eventBase}/${m.id}`}>
                      {m.headline}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {m.category} · detected {fmtDate(m.detectedAt)}
                      {m.resolvedAt ? ` · resolved ${fmtDate(m.resolvedAt)}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {m.zeroLoss ? (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800 ring-1 ring-emerald-200">
                        Zero transactions lost
                      </span>
                    ) : null}
                    <StatusBadge value={m.state} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </>
  );
}

/* ================================================================== maintenance event */

function EventStory({ e }: { e: CustomerEvent }) {
  return (
    <Card data-testid="maintenance-event" data-state={e.state}>
      <CardBody className="space-y-5">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">{e.category}</p>
          <h1 className="mt-1 text-2xl font-semibold" data-testid="event-headline">
            {e.headline}
          </h1>
          <p className="mt-2 text-slate-700">{e.summary}</p>
        </div>
        <dl className="grid gap-x-6 gap-y-3 text-sm md:grid-cols-[12rem_1fr]" data-testid="event-facts">
          {e.facts.map((f) => (
            <Fact key={f.label} label={f.label}>
              {f.value}
            </Fact>
          ))}
        </dl>
        {e.claim.statement ? (
          <div className="rounded-lg bg-emerald-50 p-4 ring-1 ring-emerald-200" data-testid="zero-loss">
            <p className="text-lg font-semibold text-emerald-900">{e.claim.statement}</p>
            <p className="text-sm text-emerald-800">{e.claim.basis}</p>
          </div>
        ) : (
          <p className="text-sm text-slate-500" data-testid="no-claim">
            {e.claim.basis}
          </p>
        )}
        {e.accounting ? (
          <div data-testid="accounting">
            <p className="mb-2 text-sm font-medium">
              Every order created {fmtDate(e.accounting.window.from)} – {fmtDate(e.accounting.window.to)}
            </p>
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <Count n={e.accounting.ordersInWindow} label="orders in this period" />
              <Count n={e.accounting.deliveredBeforeChange} label="delivered before the change" />
              <Count n={e.accounting.delayed} label="held safely and delivered after the fix" />
              <Count n={e.accounting.foundByChecking} label="never notified to us, found and recovered" />
              <Count n={e.accounting.verified} label="verified in NetSuite" />
              <Count
                n={e.accounting.unresolved}
                label="not yet confirmed"
                warn={e.accounting.unresolved > 0}
              />
            </div>
            {e.accounting.excluded ? (
              <p className="mt-2 text-xs text-slate-500">
                {e.accounting.excluded} order(s) excluded (for example cancelled).
              </p>
            ) : null}
          </div>
        ) : null}
        {e.timeline.length ? (
          <div>
            <p className="mb-2 text-sm font-medium">What happened</p>
            <ol className="space-y-1 text-sm" data-testid="event-timeline">
              {e.timeline.map((t) => (
                <li key={t.at + t.text} className="flex gap-3">
                  <span className="w-36 shrink-0 text-xs text-slate-500">{fmtDate(t.at)}</span>
                  <span>{t.text}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-medium text-slate-500">{label}</dt>
      <dd data-fact={label}>{children}</dd>
    </>
  );
}
function Count({ n, label, warn }: { n: number; label: string; warn?: boolean }) {
  return (
    <div
      className={`rounded-lg p-3 ring-1 ${warn ? 'bg-amber-50 ring-amber-200' : 'bg-slate-50 ring-slate-200'}`}
    >
      <p className="text-xl font-semibold">{n}</p>
      <p className="text-xs text-slate-600">{label}</p>
    </div>
  );
}

export function MaintenanceEventPage() {
  const { eventId } = useParams();
  const q = useCapability<CustomerEvent>('maintenance.events.get', { eventId }, [eventId]);
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return null;
  return (
    <>
      <Link className="text-sm underline" to={`/app/integrations/${q.data.integrationId}`}>
        ← Back to the integration
      </Link>
      <EventStory e={q.data} />
    </>
  );
}

/* ================================================================== operator: evidence behind the story */

interface Evidence {
  event: CustomerEvent;
  kind: string;
  status: string;
  finding: {
    expected: {
      contract: { path: string; expected: string; upstreamExpression: string; effect: string }[];
      baseline: { receiptId: string; apiVersion: string | null; receivedAt: string } | null;
    };
    observed: {
      receiptId: string;
      apiVersion: string | null;
      receivedAt: string;
      violations: { path: string; observed: string; occurrences: number }[];
    };
    shapeDiff: { removed: string[]; added: string[] } | null;
    relevance: string;
  } | null;
  investigation: {
    codePaths: {
      path: string;
      reads: { file: string; line: number; code: string; fileSha256: string; matchesPinnedCommit: boolean }[];
    }[];
    dryRun: Record<string, unknown>;
    risk: string;
  } | null;
  correction: {
    derivable: boolean;
    reason?: string;
    rules?: { target: string; source: string; evidence: Record<string, unknown> }[];
    activatedAt?: string;
    configVersion?: number;
  } | null;
  validation: { passed: boolean; checks: { name: string; passed: boolean; detail: string }[] } | null;
  accounting: {
    orders: { order: string; category: string; verified: boolean; detail: string }[];
    zeroLoss: boolean;
    populationComplete: boolean;
  } | null;
  verification: Record<string, unknown> | null;
  progress: Record<string, unknown> | null;
  reconciliationRuns: {
    id: string;
    role: string;
    status: string;
    outcome: string | null;
    windowFrom: string;
    windowTo: string;
    sourceCount: number | null;
    matchedCount: number | null;
  }[];
  timeline: {
    at: string;
    from: string | null;
    to: string;
    actor: string;
    note: string;
    customerVisible: boolean;
  }[];
}

export function OpsMaintenanceEvent() {
  const { eventId } = useParams();
  const q = useCapability<Evidence>('maintenance.events.evidence', { eventId }, ['evidence', eventId]);
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data;
  if (!d) return null;
  return (
    <>
      <p className="text-sm text-slate-500">
        What the customer sees (maintenance.events.get), then the evidence it is derived from. Status:{' '}
        <StatusBadge value={d.status} />
      </p>
      <EventStory e={d.event} />
      <Card data-testid="evidence-finding">
        <CardHeader title="Detection" description={d.finding?.relevance ?? '—'} />
        <CardBody className="space-y-2 text-sm">
          {d.finding ? (
            <>
              <p>
                Baseline: receipt {d.finding.expected.baseline?.receiptId ?? '—'} (version{' '}
                {d.finding.expected.baseline?.apiVersion ?? '—'},{' '}
                {fmtDate(d.finding.expected.baseline?.receivedAt)}) · Observed: receipt{' '}
                {d.finding.observed.receiptId} (version {d.finding.observed.apiVersion ?? '—'},{' '}
                {fmtDate(d.finding.observed.receivedAt)})
              </p>
              <p className="font-mono text-xs">
                removed: {d.finding.shapeDiff?.removed.join(', ') || '—'} · added:{' '}
                {d.finding.shapeDiff?.added.join(', ') || '—'}
              </p>
              <Table head={['Contract field', 'Expected', 'Observed', 'Upstream reads it at', 'Effect']}>
                {d.finding.observed.violations.map((v) => {
                  const c = d.finding!.expected.contract.find((x) => x.path === v.path);
                  return (
                    <tr key={v.path}>
                      <Td className="font-mono text-xs">{v.path}</Td>
                      <Td>{c?.expected}</Td>
                      <Td>
                        {v.observed} ×{v.occurrences}
                      </Td>
                      <Td className="font-mono text-xs">{c?.upstreamExpression}</Td>
                      <Td className="text-xs">{c?.effect}</Td>
                    </tr>
                  );
                })}
              </Table>
            </>
          ) : (
            '—'
          )}
        </CardBody>
      </Card>
      <Card data-testid="evidence-investigation">
        <CardHeader title="Investigation" description={d.investigation?.risk ?? 'Not yet investigated.'} />
        <CardBody className="space-y-2 text-sm">
          {d.investigation?.codePaths.flatMap((c) =>
            c.reads.map((r) => (
              <p key={`${r.file}:${r.line}`} className="font-mono text-xs">
                {r.file}:{r.line} <span className="text-slate-500">{r.code}</span> · sha256{' '}
                {r.fileSha256.slice(0, 12)}{' '}
                {r.matchesPinnedCommit
                  ? '(matches pinned upstream commit)'
                  : '(DOES NOT match pinned commit)'}
              </p>
            )),
          )}
          {d.investigation ? (
            <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-xs">
              {JSON.stringify(d.investigation.dryRun, null, 2)}
            </pre>
          ) : null}
        </CardBody>
      </Card>
      <Card data-testid="evidence-correction">
        <CardHeader
          title="Correction and validation"
          description={
            d.correction?.activatedAt
              ? `Activated ${fmtDate(d.correction.activatedAt)} as configuration version ${d.correction.configVersion}; upstream code unchanged.`
              : (d.correction?.reason ?? 'Not yet derived.')
          }
        />
        <CardBody className="space-y-2 text-sm">
          {d.correction?.rules?.map((r) => (
            <div key={r.target}>
              <p className="font-mono text-xs">
                {r.target} ← {r.source}
              </p>
              <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-xs">
                {JSON.stringify(r.evidence, null, 2)}
              </pre>
            </div>
          ))}
          {d.validation ? (
            <Table head={['Validation check', 'Result', 'Detail']}>
              {d.validation.checks.map((c) => (
                <tr key={c.name}>
                  <Td>{c.name}</Td>
                  <Td>
                    <StatusBadge value={c.passed ? 'passed' : 'failed'} />
                  </Td>
                  <Td className="text-xs">{c.detail}</Td>
                </tr>
              ))}
            </Table>
          ) : null}
        </CardBody>
      </Card>
      <Card data-testid="evidence-accounting">
        <CardHeader
          title="Transaction accounting"
          description={
            d.accounting
              ? `Population complete: ${d.accounting.populationComplete ? 'yes' : 'no'} · zero loss proven: ${d.accounting.zeroLoss ? 'yes' : 'no'}`
              : 'Not yet computed.'
          }
        />
        <CardBody className="space-y-3">
          {d.reconciliationRuns.length ? (
            <Table head={['Run', 'Role', 'Status', 'Outcome', 'Window', 'Orders']}>
              {d.reconciliationRuns.map((r) => (
                <tr key={r.id}>
                  <Td className="font-mono text-xs">{r.id.slice(0, 8)}</Td>
                  <Td>{r.role}</Td>
                  <Td>
                    <StatusBadge value={r.status} />
                  </Td>
                  <Td>{r.outcome ? <StatusBadge value={r.outcome} /> : '—'}</Td>
                  <Td className="text-xs">
                    {fmtDate(r.windowFrom)} → {fmtDate(r.windowTo)}
                  </Td>
                  <Td>
                    {r.matchedCount ?? 0}/{r.sourceCount ?? 0}
                  </Td>
                </tr>
              ))}
            </Table>
          ) : null}
          {d.accounting ? (
            <Table head={['Order', 'Category', 'Verified', 'Destination check']}>
              {d.accounting.orders.map((o) => (
                <tr key={o.order} data-testid="accounting-order">
                  <Td>{o.order}</Td>
                  <Td>{o.category.replace(/_/g, ' ')}</Td>
                  <Td>{o.verified ? 'yes' : 'no'}</Td>
                  <Td className="text-xs">{o.detail}</Td>
                </tr>
              ))}
            </Table>
          ) : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Full timeline" description="Including entries not shown to the customer." />
        <CardBody>
          <Table head={['At', 'Transition', 'Actor', 'Note', 'Customer sees']}>
            {d.timeline.map((t) => (
              <tr key={t.at + t.note}>
                <Td className="text-xs">{fmtDate(t.at)}</Td>
                <Td className="text-xs">
                  {t.from ?? '—'} → {t.to}
                </Td>
                <Td className="font-mono text-xs">{t.actor}</Td>
                <Td className="text-xs">{t.note}</Td>
                <Td>{t.customerVisible ? 'yes' : 'no'}</Td>
              </tr>
            ))}
          </Table>
        </CardBody>
      </Card>
    </>
  );
}
