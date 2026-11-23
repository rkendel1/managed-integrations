/**
 * Onboarding (slice 5): Connect → Discover → Confirm → Protect, on one page that shows only what the
 * current step needs. Discovery starts by itself once both systems are connected. Rendered from
 * onboarding.status / discover / confirm (AppPort; the same capabilities MCP exposes); connecting uses
 * the existing connection routes (OAuth redirect for Shopify, M2M certificate for NetSuite).
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
interface OnboardingView {
  status: 'connect' | 'discovering' | 'confirm' | 'select' | 'activating' | 'managed' | 'blocked';
  next: string;
  connections: {
    shopify: { connected: boolean; account: string | null };
    netsuite: { connected: boolean; account: string | null };
  };
  discovery: { outcome: string; checked: number; candidates: Candidate[] } | null;
  responsibilities: { version: string; maintain: string[]; access: string[]; verify: string[] };
  activation: {
    steps: { label: string; done: boolean }[];
    baseline: Record<string, number | string> | null;
  } | null;
  integrationId: string | null;
  problem: string | null;
}

const muted = 'text-slate-500 dark:text-zinc-500';
const panel = 'rounded-xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-zinc-900/40';
const STEPS = ['Connect', 'Discover', 'Confirm', 'Protect'] as const;
const stepIndex = (s: OnboardingView['status']) =>
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
      x.state.data?.status === 'activating' || x.state.data?.status === 'discovering' ? 2000 : false,
  });
  const d = q.data;
  const discovering = useRef(false);
  // Discovery starts by itself as soon as both systems are connected (no customer action).
  useEffect(() => {
    if (
      d?.status === 'connect' &&
      d.connections.shopify.connected &&
      d.connections.netsuite.connected &&
      !discovering.current
    ) {
      discovering.current = true;
      callCapability('onboarding.discover', {})
        .then(() => qc.invalidateQueries({ queryKey: ['appport'] }))
        .catch(setError)
        .finally(() => (discovering.current = false));
    }
  }, [d, qc]);
  if (q.error) return <ErrorNote error={q.error} />;
  if (!d) return null;
  const at = stepIndex(d.status);
  return (
    <div className="mx-auto max-w-3xl space-y-6" data-testid="onboarding" data-status={d.status}>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Put your integration under management</h1>
        <p className={cn('mt-1 text-sm', muted)}>
          Connect your systems. We find your integration, you confirm, we take care of it.
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
      {d.problem ? <ErrorNote error={new Error(d.problem)} /> : null}
      {d.status === 'connect' || d.status === 'blocked' ? <Connect d={d} onError={setError} /> : null}
      {d.status === 'discovering' ? (
        <p className={panel}>Looking for your integration in Shopify and NetSuite…</p>
      ) : null}
      {d.status === 'confirm' || d.status === 'select' ? <Confirm d={d} onError={setError} /> : null}
      {d.status === 'activating' || d.status === 'managed' ? <Protect d={d} /> : null}
      {d.status === 'blocked' ? (
        <Button
          variant="outline"
          onClick={() =>
            callCapability('onboarding.discover', {}).then(
              () => qc.invalidateQueries({ queryKey: ['appport'] }),
              setError,
            )
          }
        >
          Try again
        </Button>
      ) : null}
    </div>
  );
}

function Connect({ d, onError }: { d: OnboardingView; onError: (e: unknown) => void }) {
  const qc = useQueryClient();
  const [shop, setShop] = useState('');
  const [ns, setNs] = useState({ accountDomain: '', clientId: '', certificateId: '' });
  const [publicKey, setPublicKey] = useState<string | null>(null);
  async function shopify(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ url: string }>('/api/customer/connections/shopify/authorize', {
        method: 'POST',
        body: { shop },
      });
      window.location.assign(r.url); // Shopify asks the merchant to approve, then returns here
    } catch (err) {
      onError(err);
    }
  }
  async function netsuite(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ publicKeyPem: string }>('/api/customer/connections/netsuite', {
        method: 'POST',
        body: ns,
      });
      setPublicKey(r.publicKeyPem);
    } catch (err) {
      onError(err);
    }
  }
  async function verify() {
    try {
      await api('/api/customer/connections/netsuite/verify', { method: 'POST', body: {} });
      await qc.invalidateQueries({ queryKey: ['appport'] });
    } catch (err) {
      onError(err);
    }
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <System
        title="Shopify"
        connected={d.connections.shopify.connected}
        account={d.connections.shopify.account}
      >
        <form onSubmit={shopify} className="space-y-3">
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
      <System
        title="NetSuite"
        connected={d.connections.netsuite.connected}
        account={d.connections.netsuite.account}
      >
        {!publicKey ? (
          <form onSubmit={netsuite} className="space-y-3">
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
            <Button size="sm" onClick={verify}>
              I’ve uploaded it — verify
            </Button>
          </div>
        )}
      </System>
    </div>
  );
}

function System({
  title,
  connected,
  account,
  children,
}: {
  title: string;
  connected: boolean;
  account: string | null;
  children: ReactNode;
}) {
  return (
    <section className={panel} data-testid={`connect-${title.toLowerCase()}`} data-connected={connected}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{title}</h2>
        {connected ? (
          <span className="text-xs text-emerald-600 dark:text-emerald-300">Connected · {account}</span>
        ) : null}
      </div>
      {connected ? <p className={cn('text-sm', muted)}>Connected. Nothing else is needed here.</p> : children}
    </section>
  );
}

function Confirm({ d, onError }: { d: OnboardingView; onError: (e: unknown) => void }) {
  const qc = useQueryClient();
  const choices = d.discovery?.candidates ?? [];
  const selectable = choices.filter((c) => c.kind !== 'unsupported');
  const [chosen, setChosen] = useState<string>(d.status === 'confirm' ? (selectable[0]?.id ?? '') : '');
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try {
      await callCapability('onboarding.confirm', {
        candidateId: chosen,
        responsibilitiesVersion: d.responsibilities.version,
      });
      await qc.invalidateQueries({ queryKey: ['appport'] });
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }
  const found = d.status === 'confirm' ? choices[0] : null;
  return (
    <section className={cn(panel, 'space-y-5')} data-testid="onboarding-confirm">
      {found ? (
        <div>
          <h2 className="text-lg font-semibold">
            We found your{' '}
            {found.title.replace('Shopify orders → NetSuite sales orders', 'Shopify → NetSuite')} integration
          </h2>
          <p className={cn('mt-1 text-sm', muted)}>{found.summary}</p>
          <p className="mt-3 text-sm">Confirm that you’d like us to maintain it.</p>
        </div>
      ) : (
        <div>
          <h2 className="text-lg font-semibold">
            {d.discovery?.outcome === 'ambiguous'
              ? 'We found more than one way your orders reach NetSuite'
              : 'We could not find an integration we can take over'}
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
                  name="candidate"
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
        <List title="What we will maintain" items={d.responsibilities.maintain} />
        <List title="Access we use" items={d.responsibilities.access} />
        <List title="What we verify" items={d.responsibilities.verify} />
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

function Protect({ d }: { d: OnboardingView }) {
  const b = d.activation?.baseline;
  return (
    <section className={cn(panel, 'space-y-4')} data-testid="onboarding-protect">
      <h2 className="text-lg font-semibold">
        {d.status === 'managed'
          ? 'Your Shopify → NetSuite integration is under management.'
          : 'Setting up protection…'}
      </h2>
      <ul className="space-y-2 text-sm">
        {(d.activation?.steps ?? []).map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <Check done={s.done} /> {s.label}
          </li>
        ))}
      </ul>
      {b ? (
        <p className="text-sm" data-testid="onboarding-baseline">
          We checked {b['checked']} recent order(s): {b['accountedFor']} are in NetSuite
          {Number(b['missing'])
            ? `; ${b['missing']} never reached NetSuite — we’ll ask you before sending orders from before we took over`
            : ''}
          .
        </p>
      ) : null}
      {d.status === 'managed' ? (
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
