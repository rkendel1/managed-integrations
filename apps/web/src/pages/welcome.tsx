/**
 * Onboarding (slice 5; several integrations per customer since slice 6): Connect → Discover → Confirm →
 * Protect, on one page. The customer connects the business systems they use; discovery starts by itself
 * when the connected systems change, and each integration found is confirmed and protected on its own.
 * Rendered from onboarding.status / discover / confirm (AppPort; the same capabilities MCP exposes);
 * connecting uses the provider connection routes (OAuth for Shopify and QuickBooks, M2M certificate for
 * NetSuite, a restricted key for Stripe).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, ErrorNote, Field, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { callCapability } from '@/lib/capabilities';
import { cn } from '@/lib/utils';

interface Candidate {
  id: string;
  kind: 'adoptable' | 'unsupported' | 'new';
  title: string;
  summary: string;
  confidence: string | null;
}
type Status = 'connect' | 'discovering' | 'confirm' | 'select' | 'activating' | 'managed' | 'blocked';
interface FlowView {
  flowType: string;
  name: string;
  process: string;
  systems: string[];
  status: Status;
  next: string;
  discovery: { outcome: string; checked: number; candidates: Candidate[] } | null;
  responsibilities: { version: string; maintain: string[]; access: string[]; verify: string[] };
  activation: {
    steps: { label: string; done: boolean }[];
    baseline: Record<string, number | string> | null;
  } | null;
  integrationId: string | null;
  problem: string | null;
}
interface OnboardingView {
  status: Status;
  next: string;
  systems: { id: string; name: string; connected: boolean; account: string | null }[];
  integrations: FlowView[];
}

const muted = 'text-slate-500 dark:text-zinc-500';
const panel = 'rounded-xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-zinc-900/40';
const STEPS = ['Connect', 'Discover', 'Confirm', 'Protect'] as const;
const stepIndex = (s: Status) =>
  s === 'connect' ? 0 : s === 'discovering' ? 1 : s === 'confirm' || s === 'select' ? 2 : 3;

function Check({ done }: { done: boolean }) {
  return (
    <span
      className={cn(
        'grid h-5 w-5 place-items-center rounded-full text-[11px]',
        done ? 'bg-emerald-500 text-white' : 'ring-1 ring-slate-300 dark:ring-white/20',
      )}
    >
      {done ? '✓' : ''}
    </span>
  );
}

export function Welcome() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [error, setError] = useState<unknown>(params.get('error') ? new Error(params.get('error')!) : null);
  const q = useQuery({
    queryKey: ['appport', 'onboarding.status'],
    queryFn: () => callCapability<OnboardingView>('onboarding.status', {}),
    refetchInterval: (x) =>
      x.state.data?.integrations.some((i) => i.status === 'activating' || i.status === 'discovering')
        ? 2000
        : false,
  });
  const d = q.data;
  const looked = useRef<string | null>(null);
  // Discovery starts by itself whenever the set of connected systems changes (no customer action).
  useEffect(() => {
    if (!d) return;
    const connected = d.systems
      .filter((x) => x.connected)
      .map((x) => x.id)
      .sort()
      .join(',');
    const pending = d.integrations.length === 0 || d.integrations.some((i) => i.status === 'connect');
    if (connected.split(',').length >= 2 && pending && looked.current !== connected) {
      looked.current = connected;
      callCapability('onboarding.discover', {})
        .then(() => qc.invalidateQueries({ queryKey: ['appport'] }))
        .catch(setError);
    }
  }, [d, qc]);
  if (q.error) return <ErrorNote error={q.error} />;
  if (!d) return null;
  const at = stepIndex(d.status);
  const rediscover = () =>
    callCapability('onboarding.discover', {}).then(
      () => qc.invalidateQueries({ queryKey: ['appport'] }),
      setError,
    );
  return (
    <div className="mx-auto max-w-3xl space-y-6" data-testid="onboarding" data-status={d.status}>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Put your integrations under management</h1>
        <p className={cn('mt-1 text-sm', muted)}>
          Connect the business systems you use. We find your integrations, you confirm, we take care of them.
        </p>
        <ol className="mt-5 flex items-center gap-3 text-sm">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <Check done={i < at || d.status === 'managed'} />
              <span className={i === at && d.status !== 'managed' ? 'font-medium' : muted}>{s}</span>
              {i < STEPS.length - 1 ? (
                <span className={cn('mx-1 h-px w-8 bg-slate-200 dark:bg-white/10')} />
              ) : null}
            </li>
          ))}
        </ol>
      </header>
      <ErrorNote error={error} />
      {d.integrations.map((f) => (
        <section
          key={f.flowType}
          className="space-y-3"
          data-testid="onboarding-integration"
          data-flow={f.flowType}
          data-status={f.status}
        >
          {f.problem ? <ErrorNote error={new Error(f.problem)} /> : null}
          {f.status === 'discovering' ? (
            <p className={panel}>Looking for your integration in {f.systems.join(' and ')}…</p>
          ) : null}
          {f.status === 'confirm' || f.status === 'select' ? <Confirm f={f} onError={setError} /> : null}
          {f.status === 'activating' || f.status === 'managed' ? <Protect f={f} /> : null}
          {f.status === 'blocked' ? (
            <Button variant="outline" onClick={rediscover}>
              Try again
            </Button>
          ) : null}
        </section>
      ))}
      <Connect d={d} onError={setError} />
    </div>
  );
}

function Connect({ d, onError }: { d: OnboardingView; onError: (e: unknown) => void }) {
  const qc = useQueryClient();
  const [shop, setShop] = useState('');
  const [ns, setNs] = useState({ accountDomain: '', clientId: '', certificateId: '' });
  const [stripeKey, setStripeKey] = useState('');
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const sys = (id: string) =>
    d.systems.find((x) => x.id === id) ?? { id, name: id, connected: false, account: null };
  const run = (fn: () => Promise<unknown>) => async (e?: FormEvent) => {
    e?.preventDefault();
    try {
      await fn();
    } catch (err) {
      onError(err);
    }
  };
  const anyManaged = d.integrations.some((i) => i.status === 'managed');
  return (
    <div className="space-y-3">
      {anyManaged ? <h2 className="text-sm font-medium">Connect another system</h2> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <System s={sys('shopify')}>
          <form
            onSubmit={run(async () => {
              const r = await api<{ url: string }>('/api/customer/connections/shopify/authorize', {
                method: 'POST',
                body: { shop },
              });
              window.location.assign(r.url); // Shopify asks the merchant to approve, then returns here
            })}
            className="space-y-3"
          >
            <Field label="Your shop">
              <input
                aria-label="Shopify shop"
                className={inputClass}
                placeholder="your-store.myshopify.com"
                value={shop}
                onChange={(e) => setShop(e.target.value)}
                required
              />
            </Field>
            <Button type="submit" size="sm">
              Connect Shopify
            </Button>
            <p className={cn('text-xs', muted)}>Shopify will ask you to approve read access to orders.</p>
          </form>
        </System>
        <System s={sys('netsuite')}>
          {!publicKey ? (
            <form
              onSubmit={run(async () => {
                const r = await api<{ publicKeyPem: string }>('/api/customer/connections/netsuite', {
                  method: 'POST',
                  body: ns,
                });
                setPublicKey(r.publicKeyPem);
              })}
              className="space-y-3"
            >
              {(['accountDomain', 'clientId', 'certificateId'] as const).map((k) => (
                <Field
                  key={k}
                  label={
                    {
                      accountDomain: 'Account domain (Setup › Company › Company URLs › SuiteTalk)',
                      clientId: 'Integration client ID',
                      certificateId: 'Certificate ID',
                    }[k]
                  }
                >
                  <input
                    aria-label={`NetSuite ${k}`}
                    className={inputClass}
                    value={ns[k]}
                    onChange={(e) => setNs({ ...ns, [k]: e.target.value })}
                    required
                  />
                </Field>
              ))}
              <Button type="submit" size="sm">
                Connect NetSuite
              </Button>
            </form>
          ) : (
            <div className="space-y-3 text-sm">
              <p>
                Upload this public key as a certificate in NetSuite (OAuth 2.0 Client Credentials setup), then
                verify.
              </p>
              <textarea
                readOnly
                aria-label="NetSuite public key"
                className={cn(inputClass, 'h-28 font-mono text-[11px]')}
                value={publicKey}
              />
              <Button
                size="sm"
                onClick={run(async () => {
                  await api('/api/customer/connections/netsuite/verify', { method: 'POST', body: {} });
                  await qc.invalidateQueries({ queryKey: ['appport'] });
                })}
              >
                I’ve uploaded it — verify
              </Button>
            </div>
          )}
        </System>
        <System s={sys('stripe')}>
          <form
            onSubmit={run(async () => {
              await api('/api/customer/connections/stripe', { method: 'POST', body: { apiKey: stripeKey } });
              setStripeKey('');
              await qc.invalidateQueries({ queryKey: ['appport'] });
            })}
            className="space-y-3"
          >
            <Field label="Restricted key (Stripe › Developers › API keys)">
              <input
                aria-label="Stripe restricted key"
                type="password"
                autoComplete="off"
                className={inputClass}
                placeholder="rk_live_…"
                value={stripeKey}
                onChange={(e) => setStripeKey(e.target.value)}
                required
              />
            </Field>
            <Button type="submit" size="sm">
              Connect Stripe
            </Button>
            <p className={cn('text-xs', muted)}>
              Read access to payments and payouts, and permission to send us notifications.
            </p>
          </form>
        </System>
        <System s={sys('quickbooks')}>
          <div className="space-y-3">
            <Button
              size="sm"
              onClick={run(async () => {
                const r = await api<{ url: string }>('/api/customer/connections/quickbooks/authorize', {
                  method: 'POST',
                  body: {},
                });
                window.location.assign(r.url); // Intuit asks you to approve, then returns here
              })}
            >
              Connect QuickBooks
            </Button>
            <p className={cn('text-xs', muted)}>
              QuickBooks will ask you to approve access to your company’s accounting.
            </p>
          </div>
        </System>
      </div>
    </div>
  );
}

function System({
  s,
  children,
}: {
  s: { id: string; name: string; connected: boolean; account: string | null };
  children: ReactNode;
}) {
  return (
    <section className={panel} data-testid={`connect-${s.id}`} data-connected={s.connected}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{s.name}</h2>
        {s.connected ? (
          <span className="text-xs text-emerald-600 dark:text-emerald-300">Connected · {s.account}</span>
        ) : null}
      </div>
      {s.connected ? (
        <p className={cn('text-sm', muted)}>Connected. Nothing else is needed here.</p>
      ) : (
        children
      )}
    </section>
  );
}

function Confirm({ f, onError }: { f: FlowView; onError: (e: unknown) => void }) {
  const qc = useQueryClient();
  const choices = f.discovery?.candidates ?? [];
  const selectable = choices.filter((c) => c.kind !== 'unsupported');
  const [chosen, setChosen] = useState<string>(f.status === 'confirm' ? (selectable[0]?.id ?? '') : '');
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try {
      await callCapability('onboarding.confirm', {
        candidateId: chosen,
        responsibilitiesVersion: f.responsibilities.version,
        flowType: f.flowType,
      });
      await qc.invalidateQueries({ queryKey: ['appport'] });
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }
  const found = f.status === 'confirm' ? choices[0] : null;
  return (
    <section className={cn(panel, 'space-y-5')} data-testid="onboarding-confirm">
      {found ? (
        <div>
          <h2 className="text-lg font-semibold">We found your {f.name} integration</h2>
          <p className={cn('mt-1 text-sm', muted)}>{found.summary}</p>
          <p className="mt-3 text-sm">Confirm that you’d like us to maintain it.</p>
        </div>
      ) : (
        <div>
          <h2 className="text-lg font-semibold">
            {f.discovery?.outcome === 'ambiguous'
              ? `We found more than one way your data moves from ${f.systems[0]} to ${f.systems[1]}`
              : `${f.systems[0]} → ${f.systems[1]}: no integration we can take over`}
          </h2>
          <p className={cn('mt-1 text-sm', muted)}>Choose the integration you’d like us to maintain.</p>
          <div className="mt-3 space-y-2" role="radiogroup">
            {choices.map((c) => (
              <label
                key={c.id}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-lg p-3 ring-1',
                  c.kind === 'unsupported'
                    ? 'cursor-not-allowed opacity-60 ring-slate-200 dark:ring-white/10'
                    : chosen === c.id
                      ? 'ring-slate-900 dark:ring-white/40'
                      : 'ring-slate-200 dark:ring-white/10',
                )}
              >
                <input
                  type="radio"
                  name={`candidate-${f.flowType}`}
                  value={c.id}
                  disabled={c.kind === 'unsupported'}
                  checked={chosen === c.id}
                  onChange={() => setChosen(c.id)}
                  aria-label={c.title}
                />
                <span>
                  <span className="block text-sm font-medium">
                    {c.kind === 'new' ? 'Start a managed integration' : c.title}
                  </span>
                  <span className={cn('block text-xs', muted)}>
                    {c.kind === 'unsupported'
                      ? `${c.summary} We can’t take over its software; choose a managed integration instead.`
                      : c.summary}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="grid gap-4 text-sm md:grid-cols-3">
        <List title="What we will maintain" items={f.responsibilities.maintain} />
        <List title="Access we use" items={f.responsibilities.access} />
        <List title="What we verify" items={f.responsibilities.verify} />
      </div>
      <Button onClick={confirm} disabled={!chosen || busy}>
        Maintain this integration
      </Button>
    </section>
  );
}

function List({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-zinc-500">
        {title}
      </p>
      <ul className="list-disc space-y-1 pl-4 text-slate-700 dark:text-zinc-300">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

function Protect({ f }: { f: FlowView }) {
  const b = f.activation?.baseline;
  return (
    <section className={cn(panel, 'space-y-4')} data-testid="onboarding-protect">
      <h2 className="text-lg font-semibold">
        {f.status === 'managed'
          ? `Your ${f.name} integration is under management.`
          : `Setting up protection for ${f.name}…`}
      </h2>
      <ul className="space-y-2 text-sm">
        {(f.activation?.steps ?? []).map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <Check done={s.done} /> {s.label}
          </li>
        ))}
      </ul>
      {b ? (
        <p className="text-sm" data-testid="onboarding-baseline">
          We checked {b['checked']} recent transaction(s): {b['accountedFor']} are in {f.systems[1]}
          {Number(b['missing'])
            ? `; ${b['missing']} never reached ${f.systems[1]} — we’ll ask you before sending anything from before we took over`
            : ''}
          .
        </p>
      ) : null}
      {f.status === 'managed' ? (
        <Link
          to="/app"
          className="inline-block rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-zinc-900"
        >
          Go to your overview
        </Link>
      ) : null}
    </section>
  );
}

export function Signup() {
  const [form, setForm] = useState({ company: '', email: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ csrfToken: string }>('/api/auth/signup', { method: 'POST', body: form });
      const { setCsrf } = await import('@/lib/api');
      setCsrf(r.csrfToken);
      await qc.invalidateQueries({ queryKey: ['me'] });
      window.location.assign('/app/welcome');
    } catch (err) {
      setError(err);
    }
  }
  return (
    <div className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-1 text-lg font-semibold">Managed Integrations</h1>
      <p className="mb-6 text-sm text-slate-500">
        We keep your integrations working. Start by creating your account.
      </p>
      <form onSubmit={submit} className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
        <Field label="Company">
          <input
            name="company"
            className={inputClass}
            value={form.company}
            onChange={(e) => setForm({ ...form, company: e.target.value })}
            required
          />
        </Field>
        <Field label="Email">
          <input
            name="email"
            type="email"
            className={inputClass}
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
        </Field>
        <Field label="Password">
          <input
            name="password"
            type="password"
            minLength={12}
            className={inputClass}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
        </Field>
        <ErrorNote error={error} />
        <Button type="submit" className="w-full">
          Create account
        </Button>
        <p className="text-center text-xs text-slate-500">
          Already a customer?{' '}
          <Link to="/login" className="underline">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
