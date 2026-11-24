import { useEffect, useState, type ReactNode } from "react";

/** Minimal path router: the app's own pages under /app and /ops (OAuth returns to /app/connections). */
export function usePath(): [string, (to: string) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return [path, (to) => { history.pushState(null, "", to); setPath(to); }];
}

export function Link({ to, go, children }: { to: string; go: (to: string) => void; children: ReactNode }) {
  return <a href={to} onClick={(e) => { e.preventDefault(); go(to); }}>{children}</a>;
}

export const STATUS: Record<string, { label: string; reason: string }> = {
  protected: { label: "Protected", reason: "Running normally; every change is watched and verified." },
  maintaining: { label: "Maintaining", reason: "Something changed on a provider's side; we are adapting. Nothing is lost." },
  verified: { label: "Verified", reason: "A recent change was absorbed and checked end to end." },
  customer_action: { label: "Needs you", reason: "Only you can do the next step." },
  checking: { label: "Setting up", reason: "Taking over and checking recent history." },
};

export const KIND: Record<string, string> = {
  order_sync: "Shopify orders → NetSuite sales orders",
  ledgerly: "Stripe → QuickBooks bookkeeping",
  stripe_app: "Stripe subscriptions application",
  qbo_tools: "QuickBooks tools",
};

export function Badge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, reason: "" };
  return <span className={`badge badge-${status}`} title={s.reason}>{s.label}</span>;
}

export function Card({ title, children, testId }: { title?: string; children: ReactNode; testId?: string }) {
  return (
    <section className="card" data-testid={testId}>
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}

export function Failure({ error }: { error: unknown }) {
  const e = error as { code?: string; message?: string } | null;
  return <p role="alert" className="error">{e?.code === "NOT_FOUND" ? "Not found." : `Could not load this (${e?.code ?? "error"}): ${e?.message ?? ""}`}</p>;
}

export const when = (t?: number | null) => (t ? new Date(t).toLocaleString() : "—");
