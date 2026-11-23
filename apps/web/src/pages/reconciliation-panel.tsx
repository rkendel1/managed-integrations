import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { callCapability } from '@/lib/capabilities';
import { fmtDate } from '@/lib/utils';

interface Run {
  id: string;
  trigger: string;
  status: string;
  outcome: string | null;
  windowFrom: string;
  windowTo: string;
  pagesScanned: number;
  discovered: number;
  counts: Record<string, number>;
  recovery: Record<string, number>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}
interface Item {
  sourceOrderId: string;
  order: string;
  sourceCreatedAt: string;
  classification: string;
  reason: string | null;
  destinationIds: string[];
  recoveryState: string;
  recoverable: boolean;
  verifiedDestinationId: string | null;
}
interface RecoverOutput {
  requested: number;
  accepted: { sourceOrderId: string }[];
  refused: { sourceOrderId: string; reason: string }[];
}

/**
 * Reconciliation of an adopted integration, rendered from reconciliation.runs@1 / reconciliation.items@1
 * and acting through reconciliation.start@1 / reconciliation.recover@1 — the same capabilities MCP exposes.
 * Only exceptions (anything not delivered) are listed; delivered orders are counted.
 */
export function ReconciliationPanel({ integrationId }: { integrationId: string }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ['appport', 'reconciliation.runs', integrationId],
    queryFn: () => callCapability<{ runs: Run[] }>('reconciliation.runs', { integrationId }),
    refetchInterval: (q) => {
      const r = q.state.data?.runs[0];
      const active =
        r && (r.status === 'running' || (r.recovery['requested'] ?? 0) + (r.recovery['executing'] ?? 0) > 0);
      return active ? 2000 : false;
    },
  });
  const last = runs.data?.runs[0];
  const items = useQuery({
    queryKey: ['appport', 'reconciliation.items', last?.id, last?.status, JSON.stringify(last?.recovery)],
    queryFn: () => callCapability<{ items: Item[] }>('reconciliation.items', { runId: last!.id }),
    enabled: !!last,
  });
  const exceptions = (items.data?.items ?? []).filter(
    (i) => i.classification !== 'delivered' || i.recoveryState !== 'none',
  );

  async function act(fn: () => Promise<void>) {
    setError(null);
    setNotice(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['appport'] });
    } catch (err) {
      setError(err);
    }
  }
  const start = () =>
    act(async () => {
      const r = await callCapability<{ deduplicated: boolean }>('reconciliation.start', { integrationId });
      setNotice(
        r.deduplicated ? 'A reconciliation is already running; showing it.' : 'Reconciliation started.',
      );
    });
  const recover = () =>
    act(async () => {
      const ids = [...selected];
      const r = await callCapability<RecoverOutput>('reconciliation.recover', {
        runId: last!.id,
        sourceOrderIds: ids,
        reason: reason.trim() || 'Recovery requested from console',
        ...(ids.length > 1 ? { confirm: confirmBulk } : {}),
      });
      setNotice(
        `Recovery requested for ${r.accepted.length} order(s)` +
          (r.refused.length
            ? `; refused: ${r.refused.map((x) => `${x.sourceOrderId} (${x.reason})`).join(', ')}`
            : '.'),
      );
      setSelected(new Set());
      setConfirmBulk(false);
      setReason('');
    });
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (runs.error) return <ErrorNote error={runs.error} />;
  return (
    <Card data-testid="reconciliation">
      <CardHeader
        title="Reconciliation"
        description="Reads Shopify independently of webhooks and checks every order against delivery evidence and NetSuite."
        actions={
          <Button size="sm" onClick={start} disabled={last?.status === 'running'}>
            Run reconciliation
          </Button>
        }
      />
      <CardBody className="space-y-3">
        {notice ? <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}
        <ErrorNote error={error} />
        {!last ? (
          <Empty>No reconciliation has run yet.</Empty>
        ) : (
          <>
            <div
              className="flex flex-wrap items-center gap-4 text-sm"
              data-testid="recon-summary"
              data-status={last.status}
              data-outcome={last.outcome ?? ''}
            >
              <span>
                Last run <StatusBadge value={last.status} />{' '}
                {last.outcome ? <StatusBadge value={last.outcome} /> : null}
              </span>
              <span>
                Window {fmtDate(last.windowFrom)} → {fmtDate(last.windowTo)}
              </span>
              <span>
                Discovered <strong data-testid="recon-discovered">{last.discovered}</strong> (
                {last.pagesScanned} page(s))
              </span>
              <span>Finished {fmtDate(last.finishedAt)}</span>
            </div>
            <div className="flex flex-wrap gap-3 text-sm" data-testid="recon-counts">
              {Object.entries(last.counts).map(([k, v]) => (
                <span key={k} data-count={k}>
                  <StatusBadge value={k} /> {v}
                </span>
              ))}
              {Object.entries(last.recovery).map(([k, v]) => (
                <span key={`r-${k}`} data-recovery={k}>
                  recovery <StatusBadge value={k} /> {v}
                </span>
              ))}
            </div>
            {last.error ? <p className="text-sm text-red-700">{last.error}</p> : null}
            {exceptions.length === 0 ? (
              <Empty>No exceptions in this run.</Empty>
            ) : (
              <Table head={['', 'Order', 'Classification', 'Why', 'NetSuite', 'Recovery', 'Created']}>
                {exceptions.map((i) => (
                  <tr
                    key={i.sourceOrderId}
                    data-testid="recon-row"
                    data-classification={i.classification}
                    data-recovery={i.recoveryState}
                  >
                    <Td>
                      {i.recoverable ? (
                        <input
                          type="checkbox"
                          aria-label={`Select ${i.order}`}
                          checked={selected.has(i.sourceOrderId)}
                          onChange={() => toggle(i.sourceOrderId)}
                        />
                      ) : null}
                    </Td>
                    <Td>{i.order}</Td>
                    <Td>
                      <StatusBadge value={i.classification} />
                    </Td>
                    <Td className="max-w-xs text-xs">{i.reason ?? ''}</Td>
                    <Td className="text-xs">
                      {i.verifiedDestinationId ?? (i.destinationIds.join(', ') || '—')}
                    </Td>
                    <Td>{i.recoveryState === 'none' ? '—' : <StatusBadge value={i.recoveryState} />}</Td>
                    <Td className="text-xs">{fmtDate(i.sourceCreatedAt)}</Td>
                  </tr>
                ))}
              </Table>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <input
                aria-label="Recovery reason"
                className={`${inputClass} max-w-md`}
                placeholder="Reason for recovery (recorded as evidence)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              {selected.size > 1 ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={confirmBulk}
                    onChange={(e) => setConfirmBulk(e.target.checked)}
                  />
                  I confirm recovery of {selected.size} orders into NetSuite
                </label>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={selected.size === 0 || (selected.size > 1 && !confirmBulk)}
                onClick={recover}
              >
                Recover selected ({selected.size})
              </Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
