/**
 * Operator view (slice 5): for one managed integration, what exact code is running, what provider
 * contracts it depends on, which adapters and patches changed its behaviour, and the evidence behind each.
 * Rendered from adaptations.inspect; actions call adaptations.activate / rollback / reject / propose /
 * validate (operator-only capabilities, the same ones MCP exposes).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorNote,
  inputClass,
  StatusBadge,
  Table,
  Td,
} from '@/components/ui';
import { callCapability } from '@/lib/capabilities';
import { fmtDate } from '@/lib/utils';
import { IntegrationDetail } from './product';

interface Check {
  name: string;
  status: 'passed' | 'failed' | 'not_applicable';
  detail: string;
}
interface Adaptation {
  id: string;
  kind: 'adapter' | 'patch' | 'unsupported';
  status: string;
  maintenanceEventId: string | null;
  spec: Record<string, unknown>;
  rationale: string;
  validation: {
    passed: boolean;
    requiresDecision: boolean;
    checks: Check[];
    postActivation: Record<string, unknown> | null;
    artifact: { before: string; after: string };
  } | null;
  history: { at: string; from: string | null; to: string; actor: string; note: string }[];
  activatedAt: string | null;
  rolledBackAt: string | null;
}
interface Inspect {
  adopted: { repository: string; commit: string; license: string; package: string };
  pinnedFiles: { file: string; matches: boolean; actual: string }[];
  running: {
    id: string;
    patches: { id: string; file: string }[];
    files: Record<string, string>;
    precision: Record<string, number>;
  } | null;
  problem: string | null;
  contracts: {
    path: string;
    label: string;
    expected: string;
    effect: string;
    precision: number | null;
    reads: { file: string; line: number; code: string; matchesPinnedCommit: boolean }[];
  }[];
  adaptations: Adaptation[];
  catalog: { id: string; title: string; file: string }[];
}

const specText = (a: Adaptation) =>
  a.kind === 'adapter'
    ? `${String(a.spec['target'])} ← ${String(a.spec['source'])}`
    : a.kind === 'patch'
      ? `${String(a.spec['patchId'])} · ${String(a.spec['file'])}: ${String(a.spec['find'])} → ${String(a.spec['replace'])}`
      : String(a.spec['reason'] ?? a.rationale);

export function OpsIntegration() {
  return (
    <>
      <IntegrationDetail eventBase="/ops/maintenance-events" />
      <Monitoring />
      <AdoptedCode />
    </>
  );
}

interface MonitoringView {
  health: string;
  contract: {
    name: string;
    providers: { id: string; name: string; role: string; api: string; version: string; auth: string; client: string }[];
    capabilities: {
      discovery: string | null;
      recovery: string;
      verification: string;
      monitoring: { signal: string; method: string }[];
      corrections: { pattern: string; status: string; note: string }[];
    };
    limitations: string[];
  } | null;
  monitoring: {
    at: string;
    health: string;
    signals: { signal: string; state: string; detail: string }[];
  } | null;
}
const STATE_TONE: Record<string, string> = {
  ok: 'text-emerald-600',
  attention: 'text-amber-600',
  failing: 'text-rose-600',
  not_monitored: 'text-slate-400',
};

/** Operators: the integration's maintenance contract and its latest durable monitoring facts. */
function Monitoring() {
  const { integrationId } = useParams();
  const q = useQuery({
    queryKey: ['appport', 'monitoring.integration', integrationId],
    queryFn: () => callCapability<MonitoringView>('monitoring.integration', { integrationId }),
    retry: false,
  });
  const d = q.data;
  if (q.error || !d?.contract) return null;
  const method = (signal: string) =>
    d.contract!.capabilities.monitoring.find((m) => m.signal === signal)?.method ?? '';
  return (
    <Card data-testid="monitoring">
      <CardHeader
        title="Monitoring and maintenance contract"
        description={`${d.contract.providers.map((x) => `${x.name} (${x.role})`).join(' · ')} · health ${d.monitoring?.health ?? d.health}${d.monitoring ? ` · facts from ${new Date(d.monitoring.at).toLocaleString()}` : ' · not probed yet'}`}
      />
      <CardBody className="space-y-4">
        {d.monitoring ? (
          <Table head={['Signal', 'State', 'Observed', 'How it is monitored']}>
            {d.monitoring.signals.map((s) => (
              <tr key={s.signal} data-testid="monitoring-signal" data-signal={s.signal} data-state={s.state}>
                <Td className="font-mono text-xs">{s.signal}</Td>
                <Td className={`text-xs font-medium ${STATE_TONE[s.state] ?? ''}`}>
                  {s.state.replace('_', ' ')}
                </Td>
                <Td className="text-xs">{s.detail}</Td>
                <Td className="text-xs text-slate-500">{method(s.signal)}</Td>
              </tr>
            ))}
          </Table>
        ) : null}
        <Table head={['Correction pattern', 'Support', 'Note']}>
          {d.contract.capabilities.corrections.map((c) => (
            <tr key={c.pattern}>
              <Td className="font-mono text-xs">{c.pattern}</Td>
              <Td className="text-xs">{c.status.replace('_', ' ')}</Td>
              <Td className="text-xs">{c.note}</Td>
            </tr>
          ))}
        </Table>
        <div className="grid gap-3 text-xs md:grid-cols-2">
          <p>
            <strong>Recovery:</strong> {d.contract.capabilities.recovery}
          </p>
          <p>
            <strong>Verification:</strong> {d.contract.capabilities.verification}
          </p>
        </div>
        {d.contract.limitations.length ? (
          <div className="text-xs" data-testid="limitations">
            <strong>Limitations:</strong>
            <ul className="mt-1 list-disc pl-4">
              {d.contract.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function AdoptedCode() {
  const { integrationId } = useParams();
  const qc = useQueryClient();
  const [err, setErr] = useState<unknown>(null);
  const [reason, setReason] = useState('');
  const q = useQuery({
    queryKey: ['appport', 'adaptations.inspect', integrationId],
    queryFn: () => callCapability<Inspect>('adaptations.inspect', { integrationId }),
    retry: false,
  });
  if (q.error) return null; // not an adopted integration (or not permitted)
  const d = q.data;
  if (!d) return null;
  const act = async (name: string, input: Record<string, unknown>) => {
    setErr(null);
    try {
      await callCapability(name, { ...input, reason: reason.trim() || 'Operator decision from console' });
      await qc.invalidateQueries({ queryKey: ['appport'] });
    } catch (e) {
      setErr(e);
    }
  };
  const allPinned = d.pinnedFiles.every((f) => f.matches);
  return (
    <>
      <Card data-testid="adopted-code">
        <CardHeader
          title="Adopted code"
          description={`${d.adopted.repository} @ ${d.adopted.commit.slice(0, 12)} (${d.adopted.license}) — installed files ${allPinned ? 'match the pinned commit' : 'DO NOT match the pinned commit'}`}
          actions={
            <span className="font-mono text-xs" data-testid="running-artifact">
              {d.running?.id ?? d.problem}
            </span>
          }
        />
        <CardBody className="space-y-4">
          <p className="text-sm">
            Running: <strong>{d.running?.id}</strong>
            {d.running?.patches.length
              ? ` (patches: ${d.running.patches.map((p) => `${p.id} on ${p.file}`).join(', ')})`
              : ' (original upstream code, no patches)'}{' '}
            · {d.adaptations.filter((a) => a.status === 'active' && a.kind === 'adapter').length} active
            adapter(s) · {d.adaptations.filter((a) => a.status === 'active' && a.kind === 'patch').length}{' '}
            active patch(es)
          </p>
          <Table
            head={['Provider contract the code depends on', 'Expected', 'Read by upstream at', 'Effect']}
          >
            {d.contracts.map((c) => (
              <tr key={c.path}>
                <Td className="font-mono text-xs">{c.path}</Td>
                <Td className="text-xs">
                  {c.expected}
                  {c.precision != null ? ` (≤ ${c.precision} dp)` : ''}
                </Td>
                <Td className="font-mono text-xs">
                  {c.reads
                    .map((r) => `${r.file}:${r.line}${r.matchesPinnedCommit ? '' : ' (changed!)'}`)
                    .join(', ') || '—'}
                </Td>
                <Td className="text-xs">{c.effect}</Td>
              </tr>
            ))}
          </Table>
        </CardBody>
      </Card>
      <Card data-testid="adaptations">
        <CardHeader
          title="Adapters and patches"
          description="Every change to how the adopted code behaves for this integration, with its evidence."
        />
        <CardBody className="space-y-3">
          <ErrorNote error={err} />
          <input
            aria-label="Decision reason"
            className={inputClass}
            placeholder="Reason for your decision (recorded)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {d.adaptations.length === 0 ? (
            <p className="text-sm text-slate-500">
              No adapters or patches: the original adopted code runs unchanged.
            </p>
          ) : null}
          {d.adaptations.map((a) => (
            <details
              key={a.id}
              className="rounded-lg border border-slate-200 p-3"
              data-testid="adaptation"
              data-kind={a.kind}
              data-status={a.status}
            >
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                <StatusBadge value={a.status} />
                <span className="font-medium">{a.kind}</span>
                <span className="font-mono text-xs">{specText(a)}</span>
                {a.validation?.requiresDecision ? <StatusBadge value="decision required" /> : null}
              </summary>
              <div className="mt-3 space-y-3 text-sm">
                <p>{a.rationale}</p>
                {a.validation ? (
                  <Table head={['Validation', 'Result', 'Detail']}>
                    {a.validation.checks.map((c) => (
                      <tr key={c.name}>
                        <Td>{c.name}</Td>
                        <Td>
                          <StatusBadge value={c.status} />
                        </Td>
                        <Td className="text-xs">{c.detail}</Td>
                      </tr>
                    ))}
                  </Table>
                ) : null}
                {a.validation?.postActivation ? (
                  <p className="text-xs">After activation: {JSON.stringify(a.validation.postActivation)}</p>
                ) : null}
                <ol className="space-y-1 text-xs">
                  {a.history.map((h) => (
                    <li key={h.at + h.to}>
                      {fmtDate(h.at)} · {h.from ?? '—'} → <strong>{h.to}</strong> · {h.actor} · {h.note}
                    </li>
                  ))}
                </ol>
                <div className="flex flex-wrap gap-2">
                  {a.status === 'validated' ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        act('adaptations.activate', {
                          adaptationId: a.id,
                          acceptLimitations: a.validation?.requiresDecision ?? false,
                        })
                      }
                    >
                      {a.validation?.requiresDecision ? 'Accept limitations and activate' : 'Activate'}
                    </Button>
                  ) : null}
                  {a.status === 'active' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => act('adaptations.rollback', { adaptationId: a.id })}
                    >
                      Roll back
                    </Button>
                  ) : null}
                  {a.status === 'proposed' || a.status === 'validated' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => act('adaptations.reject', { adaptationId: a.id })}
                    >
                      Reject
                    </Button>
                  ) : null}
                </div>
              </div>
            </details>
          ))}
          {d.catalog.length ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-sm">
              <span className="text-xs text-slate-500">Reviewed patches:</span>
              {d.catalog.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant="outline"
                  onClick={() => act('adaptations.propose', { integrationId, patchId: p.id })}
                >
                  Propose {p.id}
                </Button>
              ))}
            </div>
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}
