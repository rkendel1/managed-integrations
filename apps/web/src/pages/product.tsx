/**
 * The customer product (slices 4–5): what we maintain, whether it is protected, what we did, and what it
 * meant for the customer's orders. Outcome first; details on demand (expanders, tabs). Rendered only from
 * AppPort capabilities (portfolio.list, portfolio.integration, maintenance.events.get) — the same ones MCP
 * exposes. Operators see the same event view plus the evidence behind it (maintenance.events.evidence).
 */
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { Card, CardBody, CardHeader, Empty, ErrorNote, StatusBadge, Table, Td } from '@/components/ui';
import { callCapability } from '@/lib/capabilities';
import { ago, cn, fmtDate } from '@/lib/utils';

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
interface TimelineItem {
  at: string;
  step: string;
  title: string;
  text: string;
  details: { label: string; value: string }[];
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
  timeline: TimelineItem[];
}

const useCapability = <T,>(name: string, input: unknown, key: unknown[]) =>
  useQuery({ queryKey: ['appport', name, ...key], queryFn: () => callCapability<T>(name, input) });

/* ================================================================== visual primitives */

const muted = 'text-slate-500 dark:text-zinc-500';
const soft = 'text-slate-600 dark:text-zinc-400';
const panel = 'rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-zinc-900/40';

const STATUS_TONE: Record<Status['code'], { dot: string; pill: string }> = {
  protected: {
    dot: 'bg-emerald-400',
    pill: 'text-emerald-700 ring-emerald-200 dark:text-emerald-300 dark:ring-emerald-400/20',
  },
  verified: {
    dot: 'bg-emerald-400',
    pill: 'text-emerald-700 ring-emerald-200 dark:text-emerald-300 dark:ring-emerald-400/20',
  },
  maintaining: {
    dot: 'bg-sky-400 animate-pulse',
    pill: 'text-sky-700 ring-sky-200 dark:text-sky-300 dark:ring-sky-400/20',
  },
  customer_action: {
    dot: 'bg-amber-400',
    pill: 'text-amber-800 ring-amber-200 dark:text-amber-300 dark:ring-amber-400/20',
  },
  checking: {
    dot: 'bg-zinc-400',
    pill: 'text-slate-600 ring-slate-200 dark:text-zinc-300 dark:ring-white/10',
  },
};

function StatusPill({ status }: { status: Status }) {
  const t = STATUS_TONE[status.code];
  return (
    <span
      data-testid="product-status"
      data-status={status.code}
      title={status.definition}
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium ring-1',
        t.pill,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', t.dot)} />
      {status.label}
    </span>
  );
}

const EVENT_STATE: Record<CustomerEvent['state'], { label: string; dot: string }> = {
  completed: { label: 'Resolved', dot: 'bg-emerald-400' },
  in_progress: { label: 'In progress', dot: 'bg-sky-400 animate-pulse' },
  needs_you: { label: 'Needs you', dot: 'bg-amber-400' },
};

type IconName = 'change' | 'search' | 'check' | 'bolt' | 'send' | 'list' | 'shield' | 'dot' | 'key' | 'info';
function Icon({ name, className }: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    change: <path d="M4 7h12l-3-3M20 17H8l3 3" />,
    search: (
      <>
        <circle cx="11" cy="11" r="6" />
        <path d="m20 20-4.5-4.5" />
      </>
    ),
    check: <path d="m5 12 4.5 4.5L19 7" />,
    bolt: <path d="M13 3 5 14h6l-1 7 8-11h-6z" />,
    send: <path d="M4 12h13m-5-6 6 6-6 6" />,
    list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
    shield: (
      <>
        <path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    dot: <circle cx="12" cy="12" r="2.5" />,
    key: (
      <>
        <circle cx="8" cy="15" r="3.5" />
        <path d="m10.5 12.5 8-8M16 7l2 2" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 11v5M12 8h.01" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-4 w-4', className)}
      aria-hidden
    >
      {paths[name]}
    </svg>
  );
}
const STEP_ICON: Record<string, IconName> = {
  noticed: 'change',
  investigated: 'search',
  tested: 'check',
  switched_on: 'bolt',
  delivered: 'send',
  checked: 'list',
  verifying: 'shield',
  verified: 'shield',
};

/** Source → destination tiles (generic letters; no third-party logos). */
function SystemTiles() {
  const tile = 'grid h-9 w-9 place-items-center rounded-lg text-sm font-semibold ring-1';
  return (
    <div className="flex items-center gap-1.5" aria-label="Shopify to NetSuite">
      <span
        className={cn(tile, 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-300')}
      >
        S
      </span>
      <Icon name="send" className={cn('h-3.5 w-3.5', muted)} />
      <span className={cn(tile, 'bg-indigo-500/10 text-indigo-600 ring-indigo-500/20 dark:text-indigo-300')}>
        N
      </span>
    </div>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-start gap-3 py-1.5 text-sm">
      <span className={muted}>{label}</span>
      <span className="text-slate-900 dark:text-zinc-100">{children}</span>
    </div>
  );
}

/** A native disclosure: details stay out of the way until the customer asks for them. */
function Expand({ summary, children, testId }: { summary: string; children: ReactNode; testId?: string }) {
  return (
    <details className="group" data-testid={testId}>
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium hover:text-slate-900 dark:hover:text-zinc-100',
          soft,
        )}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        {summary}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

function duration(from: string, to: string | null): string {
  if (!to) return '—';
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/* ================================================================== portfolio */

export function Portfolio() {
  const q = useCapability<{ tenant: { name: string }; integrations: IntegrationCard[] }>(
    'portfolio.list',
    {},
    [],
  );
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return null;
  const all = q.data.integrations;
  const attention = all.filter((i) => i.status.code === 'customer_action').length;
  return (
    <>
      <section className="pt-2">
        <p className={cn('text-sm', muted)}>{q.data.tenant.name}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">We keep your integrations working.</h1>
        <p className={cn('mt-1 max-w-2xl text-sm', soft)}>
          When something changes, we take care of it, verify the outcome against your systems, and tell you
          what happened. We only ask you when a decision is yours.
        </p>
        {all.length ? (
          <p className={cn('mt-4 text-sm', soft)}>
            {all.length} integration{all.length === 1 ? '' : 's'} maintained ·{' '}
            {attention ? (
              <span className="text-amber-600 dark:text-amber-300">
                {attention} need{attention === 1 ? 's' : ''} your input
              </span>
            ) : (
              'nothing needs your input'
            )}
          </p>
        ) : null}
      </section>
      {all.length === 0 ? (
        <Empty>No integrations are entrusted to us yet.</Empty>
      ) : (
        <div className="space-y-3" data-testid="portfolio">
          {all.map((i) => (
            <article key={i.id} className={cn(panel, 'p-5')} data-testid="portfolio-integration">
              <div className="flex flex-wrap items-start gap-4">
                <SystemTiles />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-base font-semibold">{i.name}</h2>
                    <StatusPill status={i.status} />
                  </div>
                  <p className={cn('text-sm', muted)}>{i.process}</p>
                  <p className="mt-3 text-sm text-slate-800 dark:text-zinc-200" data-testid="status-reason">
                    {i.status.reason}
                  </p>
                  {i.customerActions.length ? (
                    <div
                      className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-amber-400/20"
                      data-testid="actions"
                    >
                      <p className="font-medium">We need you</p>
                      <ul className="mt-1 list-disc pl-5">
                        {i.customerActions.map((a) => (
                          <li key={a}>{a}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className={cn('mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs', muted)}>
                    <span>
                      {i.lastVerified
                        ? `Last verified ${ago(i.lastVerified.at)} · ${i.lastVerified.ordersChecked} orders checked`
                        : 'Not verified yet'}
                    </span>
                    <span>{i.openIssues ? `${i.openIssues} open` : 'No open issues'}</span>
                    <Expand summary={`What does “${i.status.label}” mean?`}>
                      <p className={cn('max-w-lg text-xs', soft)}>{i.status.definition}</p>
                    </Expand>
                  </div>
                </div>
                <Link
                  className="rounded-md px-3 py-1.5 text-sm font-medium ring-1 ring-slate-200 hover:bg-slate-50 dark:ring-white/10 dark:hover:bg-white/5"
                  to={`/app/integrations/${i.id}`}
                >
                  View details
                </Link>
              </div>
            </article>
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
    <div className="grid gap-5 lg:grid-cols-[22rem_1fr]" data-testid="integration-detail">
      <aside className={cn(panel, 'space-y-5 p-5')}>
        <SystemTiles />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{d.name}</h1>
          <p className={cn('mt-1 text-sm', soft)}>{d.process}</p>
        </div>
        <div className="border-t border-slate-100 pt-3 dark:border-white/5">
          <Prop label="Status">
            <StatusPill status={d.status} />
          </Prop>
          <Prop label="Last verified">
            <span data-testid="last-verified">
              {d.lastVerified
                ? `${ago(d.lastVerified.at)} · ${d.lastVerified.ordersChecked} orders`
                : 'Not yet'}
            </span>
          </Prop>
          <Prop label="Open issues">{d.openIssues || 'None'}</Prop>
          <Prop label="Your action">
            {d.customerActions.length ? (
              <span className="text-amber-600 dark:text-amber-300">Needed</span>
            ) : (
              'None needed'
            )}
          </Prop>
        </div>
        <p className="text-sm text-slate-800 dark:text-zinc-200">{d.status.reason}</p>
        {d.customerActions.length ? (
          <div
            className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-amber-400/20"
            data-testid="actions"
          >
            {d.customerActions.map((a) => (
              <p key={a}>{a}</p>
            ))}
          </div>
        ) : null}
        <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-white/5">
          <Expand summary="What we handle for you">
            <ul className={cn('list-disc space-y-1 pl-5 text-sm', soft)} data-testid="responsibilities">
              {d.responsibilities.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Expand>
          <Expand summary={`What does “${d.status.label}” mean?`}>
            <p className={cn('text-xs', soft)}>{d.status.definition}</p>
          </Expand>
        </div>
      </aside>
      <section className={cn(panel, 'p-5')} data-testid="maintenance-history">
        <h2 className="text-sm font-semibold">Maintenance</h2>
        <p className={cn('text-xs', muted)}>Changes and issues we handled for this integration.</p>
        {d.maintenance.length === 0 ? (
          <Empty>Nothing has needed maintenance yet.</Empty>
        ) : (
          <ul className="mt-4 space-y-1">
            {d.maintenance.map((m) => (
              <li key={m.id} data-testid="maintenance-row" data-state={m.state}>
                <Link
                  to={`${eventBase}/${m.id}`}
                  className="flex items-center gap-3 rounded-lg px-3 py-3 hover:bg-slate-50 dark:hover:bg-white/5"
                >
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', EVENT_STATE[m.state].dot)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{m.headline}</span>
                    <span className={cn('block text-xs', muted)}>
                      {m.category} · {EVENT_STATE[m.state].label.toLowerCase()} ·{' '}
                      {ago(m.resolvedAt ?? m.detectedAt)}
                    </span>
                  </span>
                  {m.zeroLoss ? (
                    <span className="hidden rounded-full px-2 py-0.5 text-xs text-emerald-700 ring-1 ring-emerald-200 sm:inline dark:text-emerald-300 dark:ring-emerald-400/20">
                      Zero transactions lost
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ================================================================== maintenance event */

function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="relative" data-testid="event-timeline">
      {items.map((t, i) => (
        <li key={t.at + t.step + i} className="relative flex gap-4 pb-6 last:pb-0" data-step={t.step}>
          {i < items.length - 1 ? (
            <span className="absolute left-[11px] top-7 h-[calc(100%-1.25rem)] w-px bg-slate-200 dark:bg-white/10" />
          ) : null}
          <span
            className={cn(
              'relative z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full ring-1',
              t.step === 'verified'
                ? 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/30 dark:text-emerald-300'
                : 'bg-slate-50 text-slate-500 ring-slate-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-white/10',
            )}
          >
            <Icon name={STEP_ICON[t.step] ?? 'dot'} className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className={cn('text-xs', muted)}>
              <span className="font-medium text-slate-700 dark:text-zinc-300">{t.title}</span> ·{' '}
              <time dateTime={t.at} title={fmtDate(t.at)}>
                {ago(t.at)}
              </time>
            </p>
            <p className="mt-1 text-sm text-slate-900 dark:text-zinc-100">{t.text}</p>
            {t.details.length ? (
              <div className="mt-2">
                <Expand summary="Details">
                  <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm dark:divide-white/5 dark:border-white/10 dark:bg-zinc-950/40">
                    {t.details.map((x) => (
                      <div key={x.label} className="grid grid-cols-[minmax(0,14rem)_1fr] gap-3 px-3 py-2">
                        <dt className={muted}>{x.label}</dt>
                        <dd>{x.value}</dd>
                      </div>
                    ))}
                  </dl>
                </Expand>
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Count({ n, label, warn }: { n: number; label: string; warn?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-lg p-3 ring-1',
        warn
          ? 'bg-amber-500/10 ring-amber-500/20'
          : 'bg-slate-50 ring-slate-200 dark:bg-white/[0.03] dark:ring-white/10',
      )}
    >
      <p className="text-lg font-semibold tabular-nums">{n}</p>
      <p className={cn('text-xs', soft)}>{label}</p>
    </div>
  );
}

/** One maintenance event: outcome and properties on the left, what happened on the right. Shared by customer and operator. */
export function EventView({ e }: { e: CustomerEvent }) {
  const [tab, setTab] = useState<'activity' | 'report'>('activity');
  const state = EVENT_STATE[e.state];
  const a = e.accounting;
  const relevant = a ? a.ordersInWindow - a.excluded : 0;
  const tabCls = (on: boolean) =>
    cn(
      'rounded-md px-3 py-1.5 text-sm',
      on
        ? 'bg-slate-900 text-white dark:bg-white/10 dark:text-white'
        : cn(soft, 'hover:bg-slate-100 dark:hover:bg-white/5'),
    );
  return (
    <div className="grid gap-5 lg:grid-cols-[24rem_1fr]" data-testid="maintenance-event" data-state={e.state}>
      <aside className={cn(panel, 'space-y-5 p-5')}>
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-sky-500/10 text-sky-600 ring-1 ring-sky-500/20 dark:text-sky-300">
          <Icon name="key" className="h-5 w-5" />
        </span>
        <div>
          <p className={cn('font-mono text-xs', muted)}>#{e.id.slice(0, 6).toUpperCase()}</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight" data-testid="event-headline">
            {e.headline}
          </h1>
          <p className={cn('mt-2 text-sm', soft)}>{e.summary}</p>
        </div>
        <div className="border-t border-slate-100 pt-3 dark:border-white/5">
          <Prop label="Status">
            <span className="inline-flex items-center gap-2">
              <span className={cn('h-1.5 w-1.5 rounded-full', state.dot)} />
              {state.label}
            </span>
          </Prop>
          <Prop label="Category">{e.category}</Prop>
          <Prop label="Your action">
            {e.customerAction.required ? (
              <span className="text-amber-600 dark:text-amber-300">{e.customerAction.text ?? 'Needed'}</span>
            ) : (
              'None required'
            )}
          </Prop>
        </div>
        <div className="border-t border-slate-100 pt-3 dark:border-white/5">
          <Prop label="Detected">
            <span title={fmtDate(e.detectedAt)}>{ago(e.detectedAt)}</span>
          </Prop>
          <Prop label="Resolved">
            {e.resolvedAt ? <span title={fmtDate(e.resolvedAt)}>{ago(e.resolvedAt)}</span> : 'Not yet'}
          </Prop>
          <Prop label="Duration">{duration(e.detectedAt, e.resolvedAt)}</Prop>
        </div>
        <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-white/5">
          <p className={cn('text-[11px] font-medium uppercase tracking-wider', muted)}>
            Orders in the affected period
          </p>
          {a ? (
            <>
              <p className="text-3xl font-semibold tabular-nums">
                {a.verified}
                <span className={cn('text-base font-normal', muted)}> / {relevant} verified</span>
              </p>
              {e.claim.zeroLoss ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-500/20 dark:text-emerald-300">
                  <Icon name="shield" className="h-3.5 w-3.5" /> Zero transactions lost
                </span>
              ) : a.unresolved ? (
                <span className="inline-flex rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-500/20 dark:text-amber-300">
                  {a.unresolved} not yet confirmed
                </span>
              ) : null}
              <Expand summary="Order breakdown" testId="accounting">
                <p className={cn('mb-2 text-xs', muted)}>
                  Every order created {fmtDate(a.window.from)} – {fmtDate(a.window.to)}
                </p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <Count n={a.ordersInWindow} label="orders in this period" />
                  <Count n={a.deliveredBeforeChange} label="delivered before the change" />
                  <Count n={a.delayed} label="held safely, delivered after the fix" />
                  <Count n={a.foundByChecking} label="never notified to us, found and recovered" />
                  <Count n={a.verified} label="verified in NetSuite" />
                  <Count n={a.unresolved} label="not yet confirmed" warn={a.unresolved > 0} />
                </div>
                {a.excluded ? (
                  <p className={cn('mt-2 text-xs', muted)}>
                    {a.excluded} order(s) excluded (for example cancelled).
                  </p>
                ) : null}
              </Expand>
            </>
          ) : (
            <p className={cn('text-sm', soft)}>Being established.</p>
          )}
        </div>
      </aside>
      <section className={cn(panel, 'min-w-0')}>
        <div className="flex gap-1 border-b border-slate-100 p-2 dark:border-white/5" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'activity'}
            className={tabCls(tab === 'activity')}
            onClick={() => setTab('activity')}
          >
            Activity
          </button>
          <button
            role="tab"
            aria-selected={tab === 'report'}
            className={tabCls(tab === 'report')}
            onClick={() => setTab('report')}
          >
            Report
          </button>
        </div>
        <div className="space-y-6 p-5" hidden={tab !== 'activity'}>
          {e.claim.statement ? (
            <div
              className="flex items-start gap-3 rounded-lg bg-emerald-500/10 p-4 ring-1 ring-emerald-500/20"
              data-testid="zero-loss"
            >
              <Icon name="shield" className="mt-0.5 h-5 w-5 text-emerald-600 dark:text-emerald-300" />
              <div>
                <p className="font-semibold text-emerald-800 dark:text-emerald-200">{e.claim.statement}</p>
                <p className="text-sm text-emerald-700/80 dark:text-emerald-300/80">{e.claim.basis}</p>
              </div>
            </div>
          ) : (
            <p className={cn('text-sm', muted)} data-testid="no-claim">
              {e.claim.basis}
            </p>
          )}
          {e.timeline.length ? <Timeline items={e.timeline} /> : <Empty>No updates yet.</Empty>}
        </div>
        <div className="p-5" hidden={tab !== 'report'}>
          <dl className="divide-y divide-slate-100 text-sm dark:divide-white/5" data-testid="event-facts">
            {e.facts.map((f) => (
              <div key={f.label} className="grid gap-1 py-3 md:grid-cols-[11rem_1fr] md:gap-4">
                <dt className={muted}>{f.label}</dt>
                <dd data-fact={f.label}>{f.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
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
      <nav className={cn('flex items-center gap-2 text-sm', muted)}>
        <Link className="hover:text-slate-900 dark:hover:text-zinc-100" to="/app">
          Overview
        </Link>
        <span>/</span>
        <Link
          className="hover:text-slate-900 dark:hover:text-zinc-100"
          to={`/app/integrations/${q.data.integrationId}`}
        >
          Integration
        </Link>
        <span>/</span>
        <span className="text-slate-900 dark:text-zinc-100">{q.data.headline}</span>
      </nav>
      <EventView e={q.data} />
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
      <EventView e={d.event} />
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
