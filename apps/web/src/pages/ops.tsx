import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Empty,
  ErrorNote,
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

export function OpsInbox() {
  const q = useGet<Any[]>('/api/operator/inbox');
  return (
    <Card>
      <CardHeader
        title="Needs attention"
        description="Exceptions only. Healthy integrations do not appear here."
      />
      <CardBody>
        <ErrorNote error={q.error} />
        {q.data?.length === 0 ? <Empty>Inbox zero. Nothing needs a decision.</Empty> : null}
        <ul className="divide-y divide-slate-100" data-testid="inbox">
          {q.data?.map((i, n) => (
            <li key={n} className="py-3">
              <div className="flex items-center gap-2">
                <StatusBadge value={i.kind} />
                <Link className="text-sm font-medium underline" to={i.link}>
                  {i.title}
                </Link>
                {i.customer ? <span className="text-xs text-slate-500">· {i.customer}</span> : null}
                <span className="ml-auto text-xs text-slate-400">{fmtDate(i.at)}</span>
              </div>
              <p className="mt-1 text-xs text-slate-600">{i.why}</p>
              <p className="mt-1 text-xs font-medium">Decision: {i.decision}</p>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

export function OpsTenants() {
  const q = useGet<Any[]>('/api/operator/tenants');
  const qc = useQueryClient();
  const act = async (path: string) => {
    await api(path, { method: 'POST' });
    await qc.invalidateQueries();
  };
  return (
    <Card>
      <CardHeader title="Managed tenants" />
      <CardBody>
        <Table head={['Tenant', 'Health', 'Version', 'Canary', 'Synced through', 'Open incidents', '']}>
          {q.data?.flatMap((t) =>
            t.integrations.map((i: Any) => (
              <tr key={i.id}>
                <Td>{t.name}</Td>
                <Td>
                  <StatusBadge value={i.health} />
                </Td>
                <Td className="font-mono text-xs">{i.implementationVersionId ?? '—'}</Td>
                <Td className="font-mono text-xs">{i.canaryVersionId ?? '—'}</Td>
                <Td>{fmtDate(i.cursorWatermark)}</Td>
                <Td>{i.openIncidents}</Td>
                <Td className="space-x-2 whitespace-nowrap">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => act(`/api/operator/integrations/${i.id}/sync`)}
                  >
                    Sync
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => act(`/api/operator/integrations/${i.id}/reconcile`)}
                  >
                    Reconcile
                  </Button>
                </Td>
              </tr>
            )),
          )}
        </Table>
      </CardBody>
    </Card>
  );
}

export function OpsIncident() {
  const { id } = useParams();
  const q = useGet(`/api/operator/incidents/${id}`);
  const d = q.data;
  if (!d) return <ErrorNote error={q.error} />;
  const i = d.incident;
  return (
    <>
      <Card>
        <CardHeader
          title={i.title}
          description={`${i.kind} · detected ${fmtDate(i.detectedAt)} · implementation ${i.implementationVersionId ?? '—'}`}
          actions={<StatusBadge value={i.status} />}
        />
        <CardBody className="space-y-2 text-sm">
          <p>
            <span className="font-medium">Why:</span> {i.reason}
          </p>
          <p>
            <span className="font-medium">Impact:</span> {i.impact ?? '—'}
          </p>
          <p>
            <span className="font-medium">Customer action:</span> {i.customerAction ?? 'none'}
          </p>
          <details>
            <summary className="cursor-pointer text-xs text-slate-500">Affected scope & evidence</summary>
            <pre className="mt-2 overflow-x-auto rounded bg-slate-100 p-2 text-xs">
              {JSON.stringify(
                { affectedScope: i.affectedScope, evidence: i.evidence, verification: i.verification },
                null,
                2,
              )}
            </pre>
          </details>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="What has been attempted" />
        <CardBody className="space-y-2 text-sm">
          {d.maintenanceRuns.map((m: Any) => (
            <p key={m.id}>
              <Link className="underline" to={`/ops/maintenance/${m.id}`}>
                Maintenance run
              </Link>{' '}
              <StatusBadge value={m.status} /> {m.planner} — {m.outcome}
            </p>
          ))}
          {d.candidates.map((c: Any) => (
            <p key={c.id}>
              <Link className="underline" to={`/ops/candidates/${c.id}`}>
                Repair candidate
              </Link>{' '}
              <StatusBadge value={c.status} />
            </p>
          ))}
          {d.reconciliations.map((r: Any) => (
            <p key={r.id}>
              Reconciliation <StatusBadge value={r.outcome} /> matched {r.matchedCount}/{r.expectedCount}
            </p>
          ))}
          {!d.maintenanceRuns.length && !d.candidates.length ? (
            <Empty>Deterministic recovery only.</Empty>
          ) : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Timeline (internal)" />
        <CardBody>
          <ol className="space-y-2 text-sm">
            {d.events.map((e: Any) => (
              <li key={e.id} className="flex gap-3">
                <span className="w-44 shrink-0 text-xs text-slate-500">{fmtDate(e.createdAt)}</span>
                <StatusBadge value={e.toStatus} />
                <span className="text-xs text-slate-500">
                  {e.actor}
                  {e.customerVisible ? '' : ' · internal'}
                </span>
                <span>{e.note}</span>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>
    </>
  );
}

export function OpsCandidate() {
  const { id } = useParams();
  const q = useGet(`/api/operator/candidates/${id}`);
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const decide = async (action: 'approve' | 'reject') => {
    setErr(null);
    try {
      await api(`/api/operator/candidates/${id}/${action}`, { method: 'POST', body: { note } });
      await qc.invalidateQueries();
    } catch (e) {
      setErr(e);
    }
  };
  const d = q.data;
  if (!d) return <ErrorNote error={q.error} />;
  const c = d.candidate;
  const v = d.validations[0];
  return (
    <>
      <Card>
        <CardHeader
          title="Repair candidate"
          description={`branch ${c.branch} · commit ${c.commitSha?.slice(0, 12)} · base ${c.baseVersionId}`}
          actions={<StatusBadge value={c.status} />}
        />
        <CardBody className="space-y-2 text-sm">
          <p>
            <span className="font-medium">Hypothesis:</span> {c.hypothesis}
          </p>
          <p>
            <span className="font-medium">Changed files:</span> {c.changedFiles.join(', ')}
          </p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Independent validation"
          description="Run from a fresh tree at the base commit; agent test results are not used for this decision."
          actions={<StatusBadge value={v?.status ?? 'pending'} />}
        />
        <CardBody className="space-y-2 text-sm" data-testid="validation">
          {v ? (
            <>
              <p>
                Protected suite unchanged: <StatusBadge value={v.protectedPathsOk ? 'passed' : 'failed'} /> ·
                suite sha256 {v.testSuiteSha256.slice(0, 16)}… · reproduction profile{' '}
                {v.results.reproductionProfile ?? '—'}
              </p>
              <Table head={['Suite', 'Result', 'Isolated', 'Summary']}>
                {Object.entries((v.results.suites ?? {}) as Record<string, Any>).map(([k, s]) => (
                  <tr key={k}>
                    <Td>{k}</Td>
                    <Td>
                      <StatusBadge value={s.passed ? 'passed' : 'failed'} />
                    </Td>
                    <Td>{String(s.isolated)}</Td>
                    <Td>
                      <pre className="whitespace-pre-wrap text-xs">{s.summary}</pre>
                    </Td>
                  </tr>
                ))}
              </Table>
              {v.results.protectedPathViolations ? (
                <p className="text-red-700">
                  Protected paths modified: {v.results.protectedPathViolations.join(', ')}
                </p>
              ) : null}
            </>
          ) : (
            <Empty>Validation has not run yet.</Empty>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Diff" />
        <CardBody>
          <pre
            className="max-h-[480px] overflow-auto rounded bg-slate-950 p-3 text-xs text-slate-100"
            data-testid="diff"
          >
            {c.diff}
          </pre>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Decision"
          description="Only a human can approve. Approval starts a canary; failed canaries roll back automatically."
        />
        <CardBody className="space-y-2">
          <ErrorNote error={err} />
          <textarea
            className={inputClass}
            rows={2}
            placeholder="Decision note (required to reject)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button onClick={() => decide('approve')} disabled={c.status !== 'validated'}>
              Approve and release
            </Button>
            <Button
              variant="destructive"
              onClick={() => decide('reject')}
              disabled={!['submitted', 'validated', 'validation_failed'].includes(c.status)}
            >
              Reject
            </Button>
          </div>
          {d.releases.map((r: Any) => (
            <p key={r.id} className="text-sm">
              Release <StatusBadge value={r.status} /> {r.integrationVersionId}{' '}
              {r.rollbackReason ? `— ${r.rollbackReason}` : ''}
            </p>
          ))}
        </CardBody>
      </Card>
    </>
  );
}

export function OpsMaintenance() {
  const { id } = useParams();
  const q = useGet(`/api/operator/maintenance-runs/${id}`);
  const d = q.data;
  if (!d) return <ErrorNote error={q.error} />;
  return (
    <>
      <Card>
        <CardHeader
          title={`Maintenance run · ${d.planner ?? ''}`}
          description={`${fmtDate(d.startedAt)} → ${fmtDate(d.finishedAt)} · ${d.agentSessionRef ?? ''}`}
          actions={<StatusBadge value={d.status} />}
        />
        <CardBody className="space-y-2 text-sm">
          <p>
            <span className="font-medium">Hypothesis:</span> {d.hypothesis ?? '—'}
          </p>
          <p>
            <span className="font-medium">Outcome:</span> {d.outcome ?? '—'}
          </p>
          <p>
            <span className="font-medium">Cost:</span> {JSON.stringify(d.cost)}
          </p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Tool calls" description="Every call is policy-checked and recorded." />
        <CardBody>
          <Table head={['#', 'Tool', 'OK', 'ms', 'Result (truncated)']}>
            {(d.toolCalls as Any[]).map((t) => (
              <tr key={t.n}>
                <Td>{t.n}</Td>
                <Td className="font-mono text-xs">{t.tool}</Td>
                <Td>{t.ok ? '✓' : '✗'}</Td>
                <Td>{t.ms}</Td>
                <Td>
                  <pre className="max-w-xl whitespace-pre-wrap text-xs">{t.result.slice(0, 400)}</pre>
                </Td>
              </tr>
            ))}
          </Table>
        </CardBody>
      </Card>
    </>
  );
}

export function OpsReleases() {
  const q = useGet<Any[]>('/api/operator/releases');
  const qc = useQueryClient();
  const [err, setErr] = useState<unknown>(null);
  const rollback = async (rid: string) => {
    const reason = window.prompt('Reason for rollback?');
    if (!reason) return;
    try {
      await api(`/api/operator/releases/${rid}/rollback`, { method: 'POST', body: { reason } });
      await qc.invalidateQueries();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Card>
      <CardHeader title="Releases" />
      <CardBody>
        <ErrorNote error={err} />
        {q.data?.length === 0 ? <Empty>No releases yet.</Empty> : null}
        <Table head={['Approved', 'Version', 'Previous', 'Status', 'Canary', '']}>
          {q.data?.map((r) => (
            <tr key={r.id}>
              <Td>{fmtDate(r.approvedAt)}</Td>
              <Td className="font-mono text-xs">{r.integrationVersionId}</Td>
              <Td className="font-mono text-xs">{r.previousVersionId ?? '—'}</Td>
              <Td>
                <StatusBadge value={r.status} />
              </Td>
              <Td className="text-xs">
                {r.canaryResult
                  ? `${r.canaryResult.status ?? ''} · delivered ${r.canaryResult.delivered ?? 0} · recon ${r.canaryResult.reconciliation?.outcome ?? '—'}`
                  : '—'}
              </Td>
              <Td>
                {r.status === 'released' ? (
                  <Button size="sm" variant="destructive" onClick={() => rollback(r.id)}>
                    Roll back
                  </Button>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      </CardBody>
    </Card>
  );
}

export function OpsMetrics() {
  const q = useGet('/api/operator/metrics');
  const d = q.data;
  if (!d) return <ErrorNote error={q.error} />;
  const rows: [string, unknown][] = [
    ['Tenants', d.tenants],
    ['Incidents (total / open)', `${d.incidents.total} / ${d.incidents.open}`],
    ['Incidents per tenant', d.incidents.perTenant],
    ['Mean time to recovery', d.incidents.mttrMinutes != null ? `${d.incidents.mttrMinutes} min` : '—'],
    ['Automatic recovery rate', d.recovery.automaticRecoveryRate ?? '—'],
    ['Agent repair rate', d.maintenance.agentRepairRate ?? '—'],
    ['Validation pass rate', d.maintenance.validationPassRate ?? '—'],
    ['Model cost (USD, estimated)', d.maintenance.modelCostUsd],
    ['Human decisions', d.maintenance.humanDecisions],
    ['Sync runs (total / failed)', `${d.syncRuns.total} / ${d.syncRuns.failed}`],
  ];
  return (
    <Card>
      <CardHeader title="Service economics" description="Derived from durable state." />
      <CardBody>
        <Table head={['Measure', 'Value']}>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <Td>{k}</Td>
              <Td>{String(v)}</Td>
            </tr>
          ))}
        </Table>
        <p className="mt-3 text-xs text-slate-500">Not measured automatically: {d.notMeasured.join('; ')}.</p>
      </CardBody>
    </Card>
  );
}
