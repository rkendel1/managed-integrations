import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { Button, Card, CardBody, CardHeader, Empty, ErrorNote, inputClass, StatusBadge, Table, Td } from '@/components/ui';
import { callCapability } from '@/lib/capabilities';
import { fmtDate } from '@/lib/utils';

interface DeliverySummary {
  id: string;
  order: string;
  outcome: string;
  stuck: boolean;
  attempts: number;
  netsuiteId: string | null;
  reason: string | null;
  errorClass: string | null;
  receivedAt: string;
  updatedAt: string;
  retryable: boolean;
}
interface DeliveriesList {
  integration: {
    id: string;
    displayName: string;
    executor: { kind: string; repository: string | null; commit: string | null; license: string | null };
    lastSuccessfulExecutionAt: string | null;
  };
  counts: Record<string, number>;
  deliveries: DeliverySummary[];
}
interface DeliveryDetail {
  delivery: DeliverySummary;
  attempts: {
    attemptNo: number;
    outcome: string;
    errorClass: string | null;
    message: string | null;
    netsuiteId: string | null;
    executor: string | null;
    trigger: { kind: string; reason?: string } | null;
    upstreamResult: { status?: string; message?: string } | null;
    startedAt: string;
    finishedAt: string;
  }[];
}

/**
 * Deliveries of one integration — rendered from the AppPort capabilities deliveries.list@1 /
 * deliveries.get@1 and acting through deliveries.retry@1 (the same capabilities MCP exposes).
 * Used by both the customer (/app) and the operator (/ops) consoles; AppPort decides what each may do.
 */
export function Deliveries() {
  const { integrationId } = useParams();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['appport', 'deliveries.list', integrationId],
    queryFn: () => callCapability<DeliveriesList>('deliveries.list', { integrationId }),
  });
  const detail = useQuery({
    queryKey: ['appport', 'deliveries.get', selected],
    queryFn: () => callCapability<DeliveryDetail>('deliveries.get', { deliveryId: selected }),
    enabled: !!selected,
  });

  async function retry(deliveryId: string) {
    setActionError(null);
    setNotice(null);
    try {
      await callCapability('deliveries.retry', { deliveryId, reason: reason.trim() || 'Retry requested from console' });
      setNotice('Retry queued. The result will appear here when the executor has run.');
      setReason('');
      await qc.invalidateQueries({ queryKey: ['appport'] });
    } catch (err) {
      setActionError(err);
    }
  }

  if (list.error) return <ErrorNote error={list.error} />;
  const d = list.data;
  if (!d) return null;
  const ex = d.integration.executor;
  return (
    <>
      <Card data-testid="deliveries">
        <CardHeader
          title={d.integration.displayName || 'Integration'}
          description={
            ex.kind === 'adopted'
              ? `Executed by ${ex.repository} @ ${ex.commit?.slice(0, 12)} (${ex.license}), operated by Managed Integrations`
              : 'Executed by the Managed Integrations sync engine'
          }
        />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap gap-4 text-sm">
            <span>
              Last successful execution: <strong data-testid="last-success">{fmtDate(d.integration.lastSuccessfulExecutionAt)}</strong>
            </span>
            {Object.entries(d.counts).map(([k, v]) => (
              <span key={k}>
                <StatusBadge value={k} /> {v}
              </span>
            ))}
          </div>
          {notice ? <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}
          <ErrorNote error={actionError} />
          {d.deliveries.length === 0 ? (
            <Empty>No orders received yet.</Empty>
          ) : (
            <Table head={['Order', 'Outcome', 'NetSuite id', 'Attempts', 'Why', 'Received', '']}>
              {d.deliveries.map((x) => (
                <tr key={x.id} data-testid="delivery-row" data-outcome={x.outcome}>
                  <Td>
                    <button className="underline" onClick={() => setSelected(x.id)}>
                      {x.order}
                    </button>
                  </Td>
                  <Td>
                    <StatusBadge value={x.stuck ? 'stuck' : x.outcome} />
                  </Td>
                  <Td>{x.netsuiteId ?? '—'}</Td>
                  <Td>{x.attempts}</Td>
                  <Td className="max-w-xs text-xs">{x.reason ?? ''}</Td>
                  <Td className="text-xs">{fmtDate(x.receivedAt)}</Td>
                  <Td>
                    {x.retryable ? (
                      <Button size="sm" variant="outline" onClick={() => retry(x.id)}>
                        Retry
                      </Button>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <input
            aria-label="Retry reason"
            className={inputClass}
            placeholder="Reason for a retry (recorded as evidence)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </CardBody>
      </Card>
      {selected && detail.data ? (
        <Card data-testid="delivery-detail">
          <CardHeader title={`Order ${detail.data.delivery.order}`} actions={<StatusBadge value={detail.data.delivery.outcome} />} />
          <CardBody>
            <Table head={['#', 'Trigger', 'Outcome', 'Executor result', 'Executor', 'Finished']}>
              {detail.data.attempts.map((a) => (
                <tr key={`${a.attemptNo}-${a.startedAt}`}>
                  <Td>{a.attemptNo}</Td>
                  <Td className="text-xs">
                    {a.trigger?.kind ?? '—'}
                    {a.trigger?.reason ? ` — “${a.trigger.reason}”` : ''}
                  </Td>
                  <Td>
                    <StatusBadge value={a.outcome} />
                  </Td>
                  <Td className="text-xs">
                    {a.upstreamResult?.status ?? '—'}
                    {a.message ? `: ${a.message}` : ''}
                  </Td>
                  <Td className="font-mono text-xs">{a.executor ?? '—'}</Td>
                  <Td className="text-xs">{fmtDate(a.finishedAt)}</Td>
                </tr>
              ))}
            </Table>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
