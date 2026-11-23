import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { StrictMode, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router';
import { Button, Card, CardBody, ErrorNote, Field, inputClass } from '@/components/ui';
import { api, setCsrf } from '@/lib/api';
import { CustomerConnections, CustomerIntegration } from '@/pages/customer';
import { Deliveries } from '@/pages/deliveries';
import { IntegrationDetail, MaintenanceEventPage, OpsMaintenanceEvent, Portfolio } from '@/pages/product';
import {
  OpsCandidate,
  OpsInbox,
  OpsIncident,
  OpsMaintenance,
  OpsMetrics,
  OpsReleases,
  OpsTenants,
} from '@/pages/ops';
import './index.css';

interface Me {
  user: { email: string; role: 'customer' | 'operator' };
  csrfToken: string;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchInterval: 5000, refetchOnWindowFocus: true } },
});

function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const me = await api<Me>('/api/auth/me');
        setCsrf(me.csrfToken);
        return me;
      } catch {
        return null;
      }
    },
    refetchInterval: false,
  });
}

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();
  const nav = useNavigate();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<Me>('/api/auth/login', { method: 'POST', body: { email, password } });
      setCsrf(r.csrfToken);
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav(r.user.role === 'operator' ? '/ops' : '/app');
    } catch (err) {
      setError(err);
    }
  }
  return (
    <div className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-1 text-lg font-semibold">Managed Integrations</h1>
      <p className="mb-6 text-sm text-slate-500">
        Your application stays connected. We keep the integrations working.
      </p>
      <Card>
        <CardBody>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Email">
              <input
                name="email"
                className={inputClass}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
            <Field label="Password">
              <input
                name="password"
                className={inputClass}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
            <ErrorNote error={error} />
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

function Shell({ me, nav, children }: { me: Me; nav: [string, string][]; children: ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    setCsrf(null);
    qc.clear();
    navigate('/login');
  }
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link to="/" className="text-sm font-semibold">
            Managed Integrations{me.user.role === 'operator' ? ' · Operator' : ''}
          </Link>
          <nav className="flex flex-wrap gap-1">
            {nav.map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                end
                className={({ isActive }) =>
                  `rounded px-2 py-1 text-sm ${isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs text-slate-500">
            {me.user.email}
            <Button size="sm" variant="outline" onClick={logout}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">{children}</main>
    </div>
  );
}

function Guard({ role, children }: { role: 'customer' | 'operator'; children: (me: Me) => ReactNode }) {
  const me = useMe();
  if (me.isLoading) return null;
  if (!me.data) return <Navigate to="/login" replace />;
  if (me.data.user.role !== role)
    return <Navigate to={me.data.user.role === 'operator' ? '/ops' : '/app'} replace />;
  return <>{children(me.data)}</>;
}

// The customer product: outcomes, credentials and decisions. Operational detail lives under /ops.
const CUSTOMER_NAV: [string, string][] = [
  ['/app', 'Overview'],
  ['/app/connections', 'Connections'],
  ['/app/settings', 'Settings'],
];
const OPS_NAV: [string, string][] = [
  ['/ops', 'Inbox'],
  ['/ops/tenants', 'Tenants'],
  ['/ops/releases', 'Releases'],
  ['/ops/metrics', 'Economics'],
];

function Root() {
  const me = useMe();
  if (me.isLoading) return null;
  return <Navigate to={!me.data ? '/login' : me.data.user.role === 'operator' ? '/ops' : '/app'} replace />;
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<Root />} />
      <Route path="/login" element={<Login />} />
      <Route
        path="/app/*"
        element={
          <Guard role="customer">
            {(me) => (
              <Shell me={me} nav={CUSTOMER_NAV}>
                <Routes>
                  <Route index element={<Portfolio />} />
                  <Route path="integrations/:integrationId" element={<IntegrationDetail />} />
                  <Route path="maintenance/:eventId" element={<MaintenanceEventPage />} />
                  <Route path="connections" element={<CustomerConnections />} />
                  <Route path="settings" element={<CustomerIntegration />} />
                  <Route path="*" element={<Navigate to="/app" replace />} />
                </Routes>
              </Shell>
            )}
          </Guard>
        }
      />
      <Route
        path="/ops/*"
        element={
          <Guard role="operator">
            {(me) => (
              <Shell me={me} nav={OPS_NAV}>
                <Routes>
                  <Route index element={<OpsInbox />} />
                  <Route path="tenants" element={<OpsTenants />} />
                  <Route path="integrations/:integrationId/deliveries" element={<Deliveries />} />
                  <Route
                    path="integrations/:integrationId"
                    element={<IntegrationDetail eventBase="/ops/maintenance-events" />}
                  />
                  <Route path="maintenance-events/:eventId" element={<OpsMaintenanceEvent />} />
                  <Route path="incidents/:id" element={<OpsIncident />} />
                  <Route path="candidates/:id" element={<OpsCandidate />} />
                  <Route path="maintenance/:id" element={<OpsMaintenance />} />
                  <Route path="releases" element={<OpsReleases />} />
                  <Route path="metrics" element={<OpsMetrics />} />
                  <Route path="*" element={<Navigate to="/ops" replace />} />
                </Routes>
              </Shell>
            )}
          </Guard>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
