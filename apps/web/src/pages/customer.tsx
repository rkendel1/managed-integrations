import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorNote,
  Field,
  inputClass,
  StatusBadge,
  Table,
  Td,
} from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/utils';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const useGet = <T = Any,>(key: string) => useQuery<T>({ queryKey: [key], queryFn: () => api<T>(key) });

export function CustomerConnections() {
  const q = useGet<Any[]>('/api/customer/connections');
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [shop, setShop] = useState('');
  const [ns, setNs] = useState({ accountDomain: '', accountId: '', clientId: '', certificateId: '' });
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(params.get('error'));
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e);
    } finally {
      await qc.invalidateQueries();
    }
  };
  const byProvider = (p: string) => q.data?.find((c) => c.provider === p);
  return (
    <>
      <ErrorNote error={err} />
      {params.get('connected') ? (
        <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Shopify connected.</p>
      ) : null}
      {(['shopify', 'netsuite'] as const).map((p) => {
        const c = byProvider(p);
        return (
          <Card key={p} data-testid={`conn-${p}`}>
            <CardHeader
              title={p === 'shopify' ? 'Shopify' : 'NetSuite'}
              description={
                p === 'shopify'
                  ? 'OAuth authorization code grant · scope read_orders · expiring offline tokens'
                  : 'OAuth 2.0 client credentials (M2M) · certificate-signed JWT · scope rest_webservices'
              }
              actions={c ? <StatusBadge value={c.status} /> : <StatusBadge value="disconnected" />}
            />
            <CardBody className="space-y-3 text-sm">
              {c ? (
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                  <dt className="text-slate-500">Account</dt>
                  <dd>{c.account ?? '—'}</dd>
                  <dt className="text-slate-500">Granted scopes</dt>
                  <dd>{c.scopes.join(', ') || '—'}</dd>
                  <dt className="text-slate-500">Last verified</dt>
                  <dd>{fmtDate(c.lastVerifiedAt)}</dd>
                  {p === 'shopify' ? (
                    <>
                      <dt className="text-slate-500">Refresh token expires</dt>
                      <dd>{fmtDate(c.refreshTokenExpiresAt)}</dd>
                    </>
                  ) : null}
                  {c.problem ? (
                    <>
                      <dt className="text-slate-500">Problem</dt>
                      <dd className="text-red-700">{c.problem}</dd>
                    </>
                  ) : null}
                </dl>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {c ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      run(() => api(`/api/customer/connections/${p}/verify`, { method: 'POST' }))
                    }
                  >
                    Verify connection
                  </Button>
                ) : null}
                {c && c.status !== 'disconnected' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      run(() => api(`/api/customer/connections/${p}/disconnect`, { method: 'POST' }))
                    }
                  >
                    Disconnect
                  </Button>
                ) : null}
              </div>
              {p === 'shopify' ? (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      const r = await api<{ url: string }>('/api/customer/connections/shopify/authorize', {
                        method: 'POST',
                        body: { shop },
                      });
                      window.location.assign(r.url);
                    });
                  }}
                >
                  <input
                    className={inputClass}
                    placeholder="your-store.myshopify.com"
                    value={shop}
                    onChange={(e) => setShop(e.target.value)}
                  />
                  <Button type="submit" size="sm">
                    {c ? 'Re-authorize' : 'Connect'}
                  </Button>
                </form>
              ) : (
                <form
                  className="grid gap-2 md:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () =>
                      setPublicKey(
                        (
                          await api<{ publicKeyPem: string }>('/api/customer/connections/netsuite', {
                            method: 'POST',
                            body: ns,
                          })
                        ).publicKeyPem,
                      ),
                    );
                  }}
                >
                  {(['accountDomain', 'accountId', 'clientId', 'certificateId'] as const).map((k) => (
                    <Field key={k} label={k}>
                      <input
                        className={inputClass}
                        value={ns[k]}
                        onChange={(e) => setNs({ ...ns, [k]: e.target.value })}
                      />
                    </Field>
                  ))}
                  <div className="md:col-span-2">
                    <Button type="submit" size="sm">
                      Configure NetSuite
                    </Button>
                  </div>
                </form>
              )}
              {p === 'netsuite' && publicKey ? (
                <div>
                  <p className="mb-1 text-xs text-slate-600">
                    Map a certificate for this public key in NetSuite (Setup › Integration › OAuth 2.0 Client
                    Credentials), then Verify.
                  </p>
                  <pre className="overflow-x-auto rounded bg-slate-100 p-2 text-xs">{publicKey}</pre>
                </div>
              ) : null}
            </CardBody>
          </Card>
        );
      })}
    </>
  );
}

export function CustomerIntegration() {
  const q = useGet('/api/customer/integration');
  const qc = useQueryClient();
  const [sku, setSku] = useState({ sku: '', item: '' });
  const [err, setErr] = useState<unknown>(null);
  const patch = async (body: unknown) => {
    setErr(null);
    try {
      await api('/api/customer/integration', { method: 'PATCH', body });
      await qc.invalidateQueries();
    } catch (e) {
      setErr(e);
    }
  };
  const d = q.data;
  if (!d) return <ErrorNote error={q.error} />;
  if (d.kind === 'adopted') return <AdoptedSettings d={d} patch={patch} err={err} />;
  return (
    <>
      <Card>
        <CardHeader
          title={d.flow}
          description={`Contract ${d.contractVersion}`}
          actions={
            <div className="flex items-center gap-2">
              <StatusBadge value={d.health} />
              <Button size="sm" variant="outline" onClick={() => patch({ enabled: !d.enabled })}>
                {d.enabled ? 'Disable' : 'Enable'}
              </Button>
            </div>
          }
        />
        <CardBody className="grid gap-2 text-sm md:grid-cols-3">
          <div>
            <p className="text-xs text-slate-500">Status</p>
            {d.enabled ? 'Enabled' : 'Disabled'} · {d.lifecycle}
          </div>
          <div>
            <p className="text-xs text-slate-500">Backfill</p>
            {d.backfillCompletedAt
              ? `Completed ${fmtDate(d.backfillCompletedAt)}`
              : `From ${fmtDate(d.config.backfillFrom)} — in progress`}
          </div>
          <div>
            <p className="text-xs text-slate-500">Synced through</p>
            {fmtDate(d.cursor.watermark)}
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Configuration"
          description="SKU → NetSuite item mapping. Orders with unmapped SKUs wait for your input."
        />
        <CardBody className="space-y-3">
          <ErrorNote error={err} />
          <Table head={['Shopify SKU', 'NetSuite item id']}>
            {Object.entries(d.config.skuMap as Record<string, string>).map(([k, v]) => (
              <tr key={k}>
                <Td>{k}</Td>
                <Td>{v}</Td>
              </tr>
            ))}
          </Table>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void patch({ config: { skuMap: { ...d.config.skuMap, [sku.sku]: sku.item } } }).then(() =>
                setSku({ sku: '', item: '' }),
              );
            }}
          >
            <input
              aria-label="SKU"
              className={inputClass}
              placeholder="SKU"
              value={sku.sku}
              onChange={(e) => setSku({ ...sku, sku: e.target.value })}
            />
            <input
              aria-label="NetSuite item id"
              className={inputClass}
              placeholder="NetSuite item id"
              value={sku.item}
              onChange={(e) => setSku({ ...sku, item: e.target.value })}
            />
            <Button type="submit" size="sm">
              Add mapping
            </Button>
          </form>
          <dl className="grid grid-cols-2 gap-1 text-xs">
            <dt className="text-slate-500">NetSuite customer (entity)</dt>
            <dd>{d.config.netsuiteCustomerId}</dd>
            <dt className="text-slate-500">Subsidiary</dt>
            <dd>{d.config.netsuiteSubsidiaryId ?? '—'}</dd>
            <dt className="text-slate-500">Currency</dt>
            <dd>{d.config.currencyCode}</dd>
          </dl>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Reliability contract"
          description="What we are responsible for, and what needs you."
        />
        <CardBody className="grid gap-4 text-sm md:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">Freshness</h3>
            <p>
              Synced every {d.contract.freshness.syncIntervalMinutes} min; data no older than{' '}
              {d.contract.freshness.maxAcceptableDelayMinutes} min.
            </p>
            <h3 className="mb-1 mt-3 text-xs font-semibold uppercase text-slate-500">We own</h3>
            <ul className="list-disc pl-5">
              {d.contract.responsibility.weOwn.map((s: string) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">You own</h3>
            <ul className="list-disc pl-5">
              {d.contract.responsibility.customerOwns.map((s: string) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <h3 className="mb-1 mt-3 text-xs font-semibold uppercase text-slate-500">Not in scope</h3>
            <ul className="list-disc pl-5">
              {d.contract.scope.excluded.map((s: string) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        </CardBody>
      </Card>
    </>
  );
}

/**
 * Settings for an integration executed by adopted software: the customer's own decisions only —
 * which NetSuite customer receives each order. Everything else is operated by us.
 */
function AdoptedSettings({
  d,
  patch,
  err,
}: {
  d: { flow: string; settings: { defaultCustomer: string; customerByEmail: Record<string, string> } };
  patch: (body: unknown) => Promise<void>;
  err: unknown;
}) {
  const [def, setDef] = useState(d.settings.defaultCustomer);
  const [row, setRow] = useState({ email: '', code: '' });
  const map = d.settings.customerByEmail;
  return (
    <Card data-testid="adopted-settings">
      <CardHeader
        title="Which NetSuite customer receives each order"
        description="Business buyers are matched by e-mail to their NetSuite customer; every other order goes to your web-shop customer."
      />
      <CardBody className="space-y-5">
        <ErrorNote error={err} />
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Web-shop customer (NetSuite customer code)">
            <input
              aria-label="Web-shop customer"
              className={inputClass}
              value={def}
              onChange={(e) => setDef(e.target.value)}
            />
          </Field>
          <Button
            size="sm"
            disabled={!def.trim() || def === d.settings.defaultCustomer}
            onClick={() => void patch({ settings: { defaultCustomer: def.trim() } })}
          >
            Save
          </Button>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Business buyers</p>
          {Object.keys(map).length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-zinc-500">
              None yet: every order goes to the web-shop customer.
            </p>
          ) : (
            <Table head={['Buyer e-mail', 'NetSuite customer', '']}>
              {Object.entries(map).map(([email, code]) => (
                <tr key={email}>
                  <Td>{email}</Td>
                  <Td>{code}</Td>
                  <Td>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const next = { ...map };
                        delete next[email];
                        void patch({ settings: { customerByEmail: next } });
                      }}
                    >
                      Remove
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="Buyer e-mail">
              <input
                aria-label="Buyer e-mail"
                className={inputClass}
                value={row.email}
                onChange={(e) => setRow({ ...row, email: e.target.value })}
              />
            </Field>
            <Field label="NetSuite customer code">
              <input
                aria-label="NetSuite customer code"
                className={inputClass}
                value={row.code}
                onChange={(e) => setRow({ ...row, code: e.target.value })}
              />
            </Field>
            <Button
              size="sm"
              variant="outline"
              disabled={!row.email.trim() || !row.code.trim()}
              onClick={() =>
                void patch({
                  settings: { customerByEmail: { ...map, [row.email.trim()]: row.code.trim() } },
                }).then(() => setRow({ email: '', code: '' }))
              }
            >
              Add buyer
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
