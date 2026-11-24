/** The customer's screens: what we maintain, its status, the connections only they can grant, and outcomes. */
import { useState } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { Badge, Card, Failure, KIND, Link, STATUS, when } from "./ui";

type Go = (to: string) => void;

export function Overview({ go }: { go: Go }) {
  const q = useQueryState(api.integrations.list);
  if (q.error) return <Failure error={q.error} />;
  if (!q.data) return <p>Loading…</p>;
  if (!q.data.integrations.length)
    return (
      <Card title="Nothing under management yet" testId="empty">
        <p>Connect your systems and we will find the integration you already run.</p>
        <Link to="/app/welcome" go={go}>Set up</Link>
      </Card>
    );
  return (
    <Card title={`What we maintain for ${q.data.company?.name ?? "you"}`} testId="portfolio">
      <ul className="list">
        {q.data.integrations.map((i) => (
          <li key={i.id}>
            <Link to={`/app/integrations/${i.id}`} go={go}>{KIND[i.kind] ?? i.kind}</Link> <Badge status={i.status} />
            <div className="muted">{STATUS[i.status]?.reason}</div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function IntegrationPage({ id, go }: { id: string; go: Go }) {
  const list = useQueryState(api.integrations.list);
  const events = useQueryState(api.maintenance.list, { integrationId: id });
  const i = list.data?.integrations.find((x) => x.id === id);
  if (list.error) return <Failure error={list.error} />;
  if (list.data && !i) return <Failure error={{ code: "NOT_FOUND" }} />;
  if (!i) return <p>Loading…</p>;
  return (
    <>
      <Card title={KIND[i.kind] ?? i.kind} testId="integration">
        <p><Badge status={i.status} /> {STATUS[i.status]?.reason}</p>
      </Card>
      <Card title="Changes we handled" testId="events">
        {!events.data?.length ? <p className="muted">None yet.</p> : (
          <ul className="list">
            {events.data.map((e) => (
              <li key={e.id}><Link to={`/app/events/${e.id}`} go={go}>{e.status === "resolved" ? "Completed" : "In progress"}</Link> · opened {when(e.openedAt)}</li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

export function EventPage({ id }: { id: string }) {
  const q = useQueryState(api.maintenance.get, { eventId: id });
  if (q.error) return <Failure error={q.error} />;
  if (!q.data) return <p>Loading…</p>;
  const e = q.data;
  return (
    <Card title={e.headline} testId="event">
      <p data-testid="event-status">{e.status === "completed" ? "Completed" : e.customerAction ? "Needs you" : "In progress"}</p>
      {e.customerAction && <p className="action">Reconnect the provider on <a href="/app/connections">Connections</a>. Nothing waits longer than it must and nothing is lost.</p>}
      <ol className="timeline">
        {e.timeline.map((t, n) => <li key={n}><span className="muted">{when(t.at)}</span> {t.text}</li>)}
      </ol>
      {e.accounting && (
        <p data-testid="accounting">Affected: {e.accounting.affected} · delivered: {e.accounting.delivered} · unresolved: {e.accounting.unresolved} · duplicates: {e.accounting.duplicates}</p>
      )}
    </Card>
  );
}

export function Connections() {
  const q = useQueryState(api.connections.list);
  const begin = useMutation(api.connections.begin);
  const verify = useMutation(api.connections.verify);
  const disconnect = useMutation(api.connections.disconnect);
  const [shop, setShop] = useState("");
  const [ns, setNs] = useState({ accountDomain: "", clientId: "", certificateId: "" });
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [stripeKey, setStripeKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const conn = (p: string) => q.data?.find((c) => c.provider === p);
  const post = async (path: string, body: unknown) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: r.ok, body: (await r.json().catch(() => ({}))) as Record<string, string> };
  };
  return (
    <>
      {msg && <p role="status">{msg}</p>}
      {q.error && <Failure error={q.error} />}
      <Card title="Shopify" testId="conn-shopify">
        <p>Status: {conn("shopify")?.status ?? "not connected"} {conn("shopify")?.account ? `(${conn("shopify")!.account})` : ""}</p>
        <input aria-label="Shop URL" placeholder="https://your-shop.myshopify.com" value={shop} onChange={(e) => setShop(e.target.value)} />
        <button onClick={async () => { const { ticket } = await begin({ provider: "shopify" }); location.href = `/rt/connect/shopify?ticket=${ticket}&shop=${encodeURIComponent(shop)}`; }}>Connect Shopify</button>
      </Card>
      <Card title="NetSuite (machine-to-machine)" testId="conn-netsuite">
        <p>Status: {conn("netsuite")?.status ?? "not connected"}</p>
        {(["accountDomain", "clientId", "certificateId"] as const).map((k) => (
          <input key={k} aria-label={k} placeholder={k} value={ns[k]} onChange={(e) => setNs({ ...ns, [k]: e.target.value })} />
        ))}
        <button onClick={async () => { const { ticket } = await begin({ provider: "netsuite" }); const r = await post("/rt/connect/netsuite", { ticket, ...ns }); setPublicKey(r.ok ? r.body.publicKeyPem! : null); setMsg(r.ok ? "Register this certificate in NetSuite, then verify." : r.body.error ?? "Refused"); }}>Create certificate</button>
        {(publicKey ?? conn("netsuite")?.publicKeyPem) && <pre className="key">{publicKey ?? conn("netsuite")?.publicKeyPem}</pre>}
        {conn("netsuite") && <button onClick={() => void verify({ provider: "netsuite" })}>Verify</button>}
      </Card>
      <Card title="Stripe" testId="conn-stripe">
        <p>Status: {conn("stripe")?.status ?? "not connected"}</p>
        <input aria-label="Stripe restricted key" type="password" value={stripeKey} onChange={(e) => setStripeKey(e.target.value)} />
        <button onClick={async () => { const { ticket } = await begin({ provider: "stripe" }); const r = await post("/rt/connect/stripe", { ticket, apiKey: stripeKey }); setStripeKey(""); setMsg(r.ok ? "Stripe connected." : r.body.error ?? "Refused"); }}>Connect Stripe</button>
      </Card>
      <Card title="QuickBooks" testId="conn-quickbooks">
        <p>Status: {conn("quickbooks")?.status ?? "not connected"} {conn("quickbooks")?.detail ?? ""}</p>
        <button onClick={async () => { const { ticket } = await begin({ provider: "quickbooks" }); location.href = `/rt/connect/quickbooks?ticket=${ticket}`; }}>Connect QuickBooks</button>
      </Card>
      {q.data?.some((c) => c.status !== "disconnected") && (
        <Card title="Disconnect">
          {q.data.filter((c) => c.status !== "disconnected").map((c) => (
            <button key={c.provider} onClick={() => void disconnect({ provider: c.provider as "shopify" })}>Disconnect {c.provider}</button>
          ))}
        </Card>
      )}
    </>
  );
}

export function Onboarding({ go }: { go: Go }) {
  const q = useQueryState(api.onboarding.status);
  const discover = useMutation(api.onboarding.discover);
  const confirm = useMutation(api.onboarding.confirm);
  if (q.error) return <Failure error={q.error} />;
  if (!q.data) return <p>Loading…</p>;
  return (
    <>
      {q.data.integrations.map((o) => (
        <Card key={o.kind} title={KIND[o.kind] ?? o.kind} testId={`onboarding-${o.kind}`}>
          <p data-testid={`next-${o.kind}`}>{o.next}</p>
          {o.status === "connect" && !o.next.startsWith("Connect") && <button onClick={() => void discover({ kind: o.kind as "order_sync" })}>Find my integration</button>}
          {o.status === "connect" && o.next.startsWith("Connect") && <Link to="/app/connections" go={go}>Connect</Link>}
          {o.status === "confirm" && (
            <>
              <p>{String((o.discovery?.candidates as { summary: string }[] | undefined)?.[0]?.summary ?? "")}</p>
              <h3>We will maintain</h3>
              <ul>{o.responsibilities.maintain.map((m) => <li key={m}>{m}</li>)}</ul>
              <h3>Access we use</h3>
              <ul>{o.responsibilities.access.map((m) => <li key={m}>{m}</li>)}</ul>
              <button onClick={() => void confirm({ kind: o.kind as "order_sync", candidateId: (o.discovery!.candidates as { id: string }[])[0]!.id, responsibilitiesVersion: o.responsibilities.version })}>Maintain this integration</button>
            </>
          )}
          {o.status === "managed" && o.integrationId && <Link to={`/app/integrations/${o.integrationId}`} go={go}>Open</Link>}
        </Card>
      ))}
    </>
  );
}
