/**
 * The operator's screens, inside the customer's company (staff hold `operator` there): the open work, the
 * adopted code and its corrections with their evidence, deliveries, reconciliation, and the event evidence.
 */
import { useState } from "react";
import { useMutation, useQueryState, useTenant } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { Badge, Card, Failure, KIND, Link, when } from "./ui";

type Go = (to: string) => void;

export function Inbox({ go }: { go: Go }) {
  const tenant = useTenant();
  const q = useQueryState(api.integrations.list);
  if (q.error) return <Failure error={q.error} />;
  return (
    <>
      <Card title="Companies you support" testId="companies">
        <ul className="list">
          {tenant.tenants.filter((t) => t.role === "operator").map((t) => (
            <li key={t.id}>{t.name} {t.id === tenant.current?.id ? "(open)" : <button onClick={() => void tenant.switchTo(t.id)}>Open</button>}</li>
          ))}
        </ul>
      </Card>
      <Card title={`${tenant.current?.name}: integrations`} testId="ops-integrations">
        <ul className="list">
          {q.data?.integrations.map((i) => (
            <li key={i.id}>
              <Link to={`/ops/integrations/${i.id}`} go={go}>{KIND[i.kind] ?? i.kind}</Link> <Badge status={i.status} /> <span className="muted">{i.upstream.repository} @ {i.upstream.commit.slice(0, 12)}</span>
              <OpenEvents integrationId={i.id} go={go} />
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function OpenEvents({ integrationId, go }: { integrationId: string; go: Go }) {
  const q = useQueryState(api.maintenance.list, { integrationId });
  const open = q.data?.filter((e) => e.status !== "resolved") ?? [];
  if (!open.length) return null;
  return <ul>{open.map((e) => <li key={e.id}><Link to={`/ops/events/${e.id}`} go={go}>{e.kind} · {e.boundary} · {e.status}</Link></li>)}</ul>;
}

export function OpsIntegration({ id, go }: { id: string; go: Go }) {
  const inspect = useQueryState(api.corrections.inspect, { integrationId: id });
  const events = useQueryState(api.maintenance.list, { integrationId: id });
  const activate = useMutation(api.corrections.activate);
  const rollback = useMutation(api.corrections.rollback);
  const reject = useMutation(api.corrections.reject);
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (f: () => Promise<unknown>, done: string) => { try { await f(); setMsg(done); } catch (e) { setMsg((e as Error).message); } };
  if (inspect.error) return <Failure error={inspect.error} />;
  const x = inspect.data;
  return (
    <>
      {msg && <p role="status">{msg}</p>}
      <Card title="Adopted code" testId="adopted-code">
        {x && <p>{x.upstream.repository} @ <code>{x.upstream.commit.slice(0, 12)}</code> ({x.upstream.license}) · running: {x.running.length ? x.running.join(", ") : "as pinned"}</p>}
      </Card>
      <Card title="Corrections" testId="corrections">
        {!x?.corrections.length ? <p className="muted">None.</p> : x.corrections.map((c) => (
          <div key={c.id} className="correction" data-testid={`correction-${c.kind}`}>
            <p><strong>{c.kind}</strong> {String(c.spec.adapter ?? c.spec.patch ?? c.spec.dependency ?? "")} — <em>{c.status}</em></p>
            <p className="muted">{c.history.map((h) => h.to).join(" → ")}</p>
            {c.validation && <ul>{((c.validation as { checks: { name: string; result: string; detail: string }[] }).checks ?? []).map((k) => <li key={k.name}>{k.result === "passed" ? "✓" : "✗"} {k.name} — {k.detail}</li>)}</ul>}
            {c.postActivation && <p>After activation: {JSON.stringify(c.postActivation)}</p>}
            {c.status === "validated" && <button onClick={() => void act(() => activate({ correctionId: c.id, reason: "Reviewed in the operator view" }), "Activated")}>Activate</button>}
            {(c.status === "proposed" || c.status === "validated") && <button onClick={() => void act(() => reject({ correctionId: c.id, reason: "Rejected in the operator view" }), "Rejected")}>Reject</button>}
            {c.status === "active" && <button onClick={() => void act(() => rollback({ correctionId: c.id, reason: "Rolled back in the operator view" }), "Rolled back")}>Roll back</button>}
          </div>
        ))}
      </Card>
      <Card title="Maintenance events" testId="ops-events">
        <ul className="list">{events.data?.map((e) => <li key={e.id}><Link to={`/ops/events/${e.id}`} go={go}>{e.kind} · {e.boundary}</Link> — {e.status} · {when(e.openedAt)}</li>)}</ul>
      </Card>
      <Deliveries integrationId={id} />
      <Reconciliation integrationId={id} />
    </>
  );
}

function Deliveries({ integrationId }: { integrationId: string }) {
  const q = useQueryState(api.deliveries.list, { integrationId });
  const retry = useMutation(api.deliveries.retry);
  if (q.error) return null; // not every integration has deliveries
  return (
    <Card title="Deliveries" testId="deliveries">
      <table>
        <thead><tr><th>Order / event</th><th>Status</th><th>Target</th><th>Attempts</th><th /></tr></thead>
        <tbody>
          {q.data?.deliveries.slice(0, 50).map((d) => (
            <tr key={d.id}>
              <td>{d.reference}</td><td>{d.status}{d.reason ? ` — ${d.reason}` : ""}</td><td>{d.destinationRef ?? ""}</td><td>{d.attempts}</td>
              <td>{(d.status === "rejected" || d.status === "failed" || d.status === "held") && <button onClick={() => void retry({ deliveryId: d.id, reason: "Retried from the operator view" })}>Retry</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Reconciliation({ integrationId }: { integrationId: string }) {
  const runs = useQueryState(api.reconcile.runs, { integrationId });
  const start = useMutation(api.reconcile.start);
  const recover = useMutation(api.reconcile.recover);
  const latest = runs.data?.runs[0];
  const items = useQueryState(api.reconcile.items, latest ? { runId: latest.id } : "skip");
  const missing = items.data?.items.filter((i) => i.classification === "missing_delivery" && i.recovery === "none") ?? [];
  const [confirming, setConfirming] = useState(false);
  if (runs.error) return null;
  return (
    <Card title="Reconciliation" testId="reconciliation">
      <button onClick={() => void start({ integrationId })}>Check the source now</button>
      {latest && <p>Last run {latest.status}: {JSON.stringify(latest.counts)} ({latest.window.from} → {latest.window.to})</p>}
      <ul>{items.data?.items.filter((i) => i.classification !== "delivered").map((i) => <li key={i.id}>{i.reference} — {i.classification} · recovery {i.recovery}{i.verifiedAt ? " · verified" : ""}</li>)}</ul>
      {missing.length === 1 && <button onClick={() => void recover({ runId: latest!.id, sourceIds: [missing[0]!.sourceId] })}>Recover {missing[0]!.reference}</button>}
      {missing.length > 1 && !confirming && <button onClick={() => setConfirming(true)}>Recover all {missing.length}</button>}
      {missing.length > 1 && confirming && (
        <p role="alert">Recover {missing.length} orders through the adopted code? <button onClick={() => { setConfirming(false); void recover({ runId: latest!.id, sourceIds: missing.map((m) => m.sourceId) }); }}>Confirm</button> <button onClick={() => setConfirming(false)}>Cancel</button></p>
      )}
    </Card>
  );
}

export function Evidence({ id, go }: { id: string; go: Go }) {
  const q = useQueryState(api.maintenance.evidence, { eventId: id });
  const customer = useQueryState(api.maintenance.get, { eventId: id });
  if (q.error) return <Failure error={q.error} />;
  if (!q.data) return <p>Loading…</p>;
  const e = q.data.event as { integrationId: string; kind: string; boundary: string; status: string; finding?: Record<string, unknown>; accounting?: Record<string, number>; timeline: { at: number; text: string; customerVisible: boolean }[] };
  return (
    <>
      <Card title={`${e.kind} · ${e.boundary} · ${e.status}`} testId="evidence">
        <p><Link to={`/ops/integrations/${e.integrationId}`} go={go}>Integration</Link></p>
        <h3>Finding</h3>
        <pre>{JSON.stringify(e.finding, null, 2)}</pre>
        {e.accounting && <p data-testid="ops-accounting">Accounting: {JSON.stringify(e.accounting)}</p>}
        <h3>Timeline (internal entries marked)</h3>
        <ol className="timeline">{e.timeline.map((t, n) => <li key={n}>{t.customerVisible ? "" : "[internal] "}{t.text}</li>)}</ol>
        <h3>Corrections</h3>
        <ul>{(q.data.corrections as { id: string; kind: string; status: string }[]).map((c) => <li key={c.id}>{c.kind} — {c.status}</li>)}</ul>
      </Card>
      <Card title="What the customer sees" testId="customer-projection">
        {customer.data && <ol>{customer.data.timeline.map((t, n) => <li key={n}>{t.text}</li>)}</ol>}
      </Card>
    </>
  );
}
