import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Empty,
  ErrorNote,
  Field,
  inputClass,
  StatusBadge,
  Table,
  Td,
} from '@/components/ui';
import { api } from '@/lib/api';
import { ago, fmtDate } from '@/lib/utils';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const useGet = <T = Any,>(key: string) => useQuery<T>({ queryKey: [key], queryFn: () => api<T>(key) });

export function CustomerOverview() {
  const q = useGet('/api/customer/overview');
  const qc = useQueryClient();
  const sync = useMutation({
    mutationFn: () => api('/api/customer/integration/sync', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries(),
  });
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data;
  if (!d) return null;
  return (
    <>
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardBody>
            <p className="text-xs text-slate-500">Integration health</p>
            <div className="mt-1" data-testid="health">
              <StatusBadge value={d.integration?.health} />
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-xs text-slate-500">Last successful sync</p>
            <p className="mt-1 text-sm font-medium" data-testid="last-sync">
              {ago(d.integration?.lastSuccessfulSyncAt)}
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-xs text-slate-500">Freshness</p>
            <p className="mt-1 text-sm font-medium">
              {d.freshness
                ? d.freshness.withinCommitment
                  ? `Within ${d.freshness.commitmentMinutes} min commitment`
                  : `Behind ${d.freshness.commitmentMinutes} min commitment`
                : '—'}
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-xs text-slate-500">Open incidents</p>
            <p className="mt-1 text-sm font-medium" data-testid="open-incidents">
              {d.openIncidents.length}
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Action required"
          description="Things only you can do. Everything else is handled for you."
        />
        <CardBody>
          {d.actionRequired.length === 0 ? (
            <Empty>Nothing needs your attention.</Empty>
          ) : (
            <ul className="space-y-2" data-testid="actions">
              {d.actionRequired.map((a: Any, i: number) => (
                <li key={i} className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
                  {a.message}{' '}
                  {a.incidentId ? (
                    <Link className="underline" to={`/app/incidents/${a.incidentId}`}>
                      Details
                    </Link>
                  ) : (
                    <Link className="underline" to="/app/connections">
                      Connections
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Connections" />
          <CardBody className="space-y-2">
            {d.connections.map((c: Any) => (
              <div key={c.provider} className="flex justify-between text-sm">
                <span className="capitalize">{c.provider}</span>
                <StatusBadge value={c.status} />
              </div>
            ))}
            {d.connections.length === 0 ? <Empty>No connections yet.</Empty> : null}
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Open incidents"
            actions={
              <Button size="sm" variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
                Sync now
              </Button>
            }
          />
          <CardBody className="space-y-3">
            {d.openIncidents.length === 0 ? <Empty>No open incidents.</Empty> : null}
            {d.openIncidents.map((i: Any) => (
              <Link
                key={i.id}
                to={`/app/incidents/${i.id}`}
                className="block rounded border border-slate-200 p-3 hover:bg-slate-50"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{i.title}</span>
                  <StatusBadge value={i.status} />
                </div>
                <p className="mt-1 text-xs text-slate-600">{i.summary}</p>
              </Link>
            ))}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

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

export function CustomerRuns() {
  const q = useGet<Any[]>('/api/customer/sync-runs');
  return (
    <Card>
      <CardHeader title="Delivery history" description="Every sync run, with record-level outcomes." />
      <CardBody>
        {q.data?.length === 0 ? <Empty>No sync runs yet.</Empty> : null}
        <Table head={['Started', 'Mode', 'Status', 'Delivered', 'Already', 'Rejected', 'Failed', 'Duration']}>
          {q.data?.map((r) => (
            <tr key={r.id} data-testid="run-row">
              <Td>
                <Link className="underline" to={`/app/history/${r.id}`}>
                  {fmtDate(r.startedAt)}
                </Link>
              </Td>
              <Td>{r.mode}</Td>
              <Td>
                <StatusBadge value={r.status} />
              </Td>
              <Td>{r.counts.delivered}</Td>
              <Td>{r.counts.alreadyDelivered}</Td>
              <Td>{r.counts.rejected}</Td>
              <Td>{r.counts.failed}</Td>
              <Td>{r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)} s` : '—'}</Td>
            </tr>
          ))}
        </Table>
      </CardBody>
    </Card>
  );
}

export function CustomerRun() {
  const { id } = useParams();
  const q = useGet(`/api/customer/sync-runs/${id}`);
  const d = q.data;
  if (!d) return <ErrorNote error={q.error} />;
  return (
    <Card>
      <CardHeader
        title={`Sync run · ${d.mode}`}
        description={`${fmtDate(d.startedAt)} → ${fmtDate(d.finishedAt)} · ${d.pages} page(s)`}
        actions={<StatusBadge value={d.status} />}
      />
      <CardBody className="space-y-3">
        {d.error ? (
          <p className="text-sm text-red-700">
            This run stopped safely ({d.error.class}). {d.error.message}
          </p>
        ) : null}
        <Table head={['Order', 'Outcome', 'NetSuite id', 'External id', 'Attempts', 'Reason']}>
          {d.records.map((r: Any) => (
            <tr key={r.externalId}>
              <Td>{r.order}</Td>
              <Td>
                <StatusBadge value={r.outcome} />
              </Td>
              <Td>{r.netsuiteId ?? '—'}</Td>
              <Td className="font-mono text-xs">{r.externalId}</Td>
              <Td>{r.attempts}</Td>
              <Td className="text-xs">{r.reason ?? ''}</Td>
            </tr>
          ))}
        </Table>
      </CardBody>
    </Card>
  );
}

export function CustomerReliability() {
  const q = useGet('/api/customer/reliability');
  const d = q.data;
  if (!d) return <ErrorNote error={q.error} />;
  return (
    <>
      <Card>
        <CardHeader title="Delivery totals" />
        <CardBody className="flex flex-wrap gap-6 text-sm">
          {Object.entries(d.deliveryTotals as Record<string, number>).map(([k, v]) => (
            <div key={k}>
              <StatusBadge value={k} /> <span className="ml-1 font-medium">{v}</span>
            </div>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Reconciliation"
          description="Shopify orders compared independently against delivery evidence and NetSuite records."
        />
        <CardBody>
          {d.reconciliations.length === 0 ? <Empty>No reconciliation has run yet.</Empty> : null}
          <Table
            head={[
              'When',
              'Trigger',
              'Outcome',
              'Expected',
              'Matched',
              'Missing',
              'Duplicate',
              'Inconsistent',
              'Stale',
              'Unresolved',
            ]}
          >
            {d.reconciliations.map((r: Any) => (
              <tr key={r.id} data-testid="recon-row">
                <Td>{fmtDate(r.startedAt)}</Td>
                <Td>{r.trigger}</Td>
                <Td>
                  <StatusBadge value={r.outcome ?? r.status} />
                </Td>
                <Td>{r.expected}</Td>
                <Td>{r.matched}</Td>
                <Td>{r.missing.length}</Td>
                <Td>{r.duplicates.length}</Td>
                <Td>{r.inconsistent.length}</Td>
                <Td>{r.stale.length}</Td>
                <Td>{r.unresolved.length}</Td>
              </tr>
            ))}
          </Table>
        </CardBody>
      </Card>
    </>
  );
}

export function CustomerIncidents() {
  const q = useGet<Any[]>('/api/customer/incidents');
  return (
    <Card>
      <CardHeader title="Incidents" />
      <CardBody>
        {q.data?.length === 0 ? <Empty>No incidents.</Empty> : null}
        <Table head={['Detected', 'Incident', 'Severity', 'Status', 'Resolved']}>
          {q.data?.map((i) => (
            <tr key={i.id}>
              <Td>{fmtDate(i.detectedAt)}</Td>
              <Td>
                <Link className="underline" to={`/app/incidents/${i.id}`}>
                  {i.title}
                </Link>
              </Td>
              <Td>
                <StatusBadge value={i.severity} />
              </Td>
              <Td>
                <StatusBadge value={i.status} />
              </Td>
              <Td>{fmtDate(i.resolvedAt)}</Td>
            </tr>
          ))}
        </Table>
      </CardBody>
    </Card>
  );
}

export function CustomerIncident() {
  const { id } = useParams();
  const q = useGet(`/api/customer/incidents/${id}`);
  const d = q.data;
  if (!d) return <ErrorNote error={q.error} />;
  return (
    <>
      <Card>
        <CardHeader
          title={d.title}
          description={`Detected ${fmtDate(d.detectedAt)}`}
          actions={<StatusBadge value={d.status} />}
        />
        <CardBody className="space-y-3 text-sm">
          <p>{d.summary}</p>
          {d.impact ? (
            <p>
              <span className="font-medium">Impact:</span> {d.impact}
            </p>
          ) : null}
          {d.customerAction ? (
            <p className="rounded bg-amber-50 px-3 py-2">
              <span className="font-medium">Your action:</span> {d.customerAction}
            </p>
          ) : (
            <p className="text-slate-500">No action is needed from you.</p>
          )}
          {d.resolution ? (
            <p className="rounded bg-emerald-50 px-3 py-2" data-testid="resolution">
              <span className="font-medium">Resolution:</span> {d.resolution}
            </p>
          ) : null}
          {d.affectedOrders.length ? (
            <p>
              <span className="font-medium">Affected orders ({d.affectedOrderCount}):</span>{' '}
              {d.affectedOrders.join(', ')}
            </p>
          ) : null}
          {d.rejectedOrders.length ? (
            <Table head={['Order', 'Why it was not delivered']}>
              {d.rejectedOrders.map((o: Any) => (
                <tr key={o.order}>
                  <Td>{o.order}</Td>
                  <Td>{o.reason}</Td>
                </tr>
              ))}
            </Table>
          ) : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Timeline" />
        <CardBody>
          <ol className="space-y-2 text-sm" data-testid="timeline">
            {d.timeline.map((e: Any, i: number) => (
              <li key={i} className="flex gap-3">
                <span className="w-44 shrink-0 text-xs text-slate-500">{fmtDate(e.at)}</span>
                <StatusBadge value={e.status} />
                <span>{e.note}</span>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>
    </>
  );
}
