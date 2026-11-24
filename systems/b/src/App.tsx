/**
 * The product UI. Sign-in, invitations, workspaces (companies) and members are FeltKit's own screens; this
 * file adds only the product: the customer's view (outcomes, no machinery) and the operator's (evidence and
 * the actions only staff take). Which one a person sees follows their role in the current company.
 */
import { AcceptInvitation, AuthNotices, CreateTenant, SignIn, TenantSettings, TenantSwitcher, useAuth, useAuthRedirect, useTenant } from "@feltdb/feltkit/react";
import { usePath, Link } from "./ui";
import { Connections, EventPage, IntegrationPage, Onboarding, Overview } from "./customer";
import { Evidence, Inbox, OpsIntegration } from "./ops";

export function App() {
  const auth = useAuth();
  const tenant = useTenant();
  const { redirect } = useAuthRedirect();
  const [path, go] = usePath();
  if (auth.loading) return null;
  if (redirect?.kind === "invitation") return <AcceptInvitation />;
  if (!auth.user) return <SignIn brand={{ name: "Managed Integrations" }} />;
  if (!tenant.current) return <CreateTenant />;

  const staff = tenant.current.role === "operator";
  const seg = path.split("/").filter(Boolean);
  let page;
  if (staff) {
    if (seg[0] === "ops" && seg[1] === "integrations" && seg[2]) page = <OpsIntegration id={seg[2]} go={go} />;
    else if (seg[0] === "ops" && seg[1] === "events" && seg[2]) page = <Evidence id={seg[2]} go={go} />;
    else page = <Inbox go={go} />;
  } else if (seg[1] === "connections") page = <Connections />;
  else if (seg[1] === "welcome") page = <Onboarding go={go} />;
  else if (seg[1] === "integrations" && seg[2]) page = <IntegrationPage id={seg[2]} go={go} />;
  else if (seg[1] === "events" && seg[2]) page = <EventPage id={seg[2]} />;
  else if (seg[1] === "company") page = <TenantSettings />;
  else page = <Overview go={go} />;

  return (
    <div className="shell">
      <header>
        <strong>Managed Integrations</strong>
        <nav>
          {staff ? (
            <Link to="/ops" go={go}>Inbox</Link>
          ) : (
            <>
              <Link to="/app" go={go}>Overview</Link>
              <Link to="/app/welcome" go={go}>Set up</Link>
              <Link to="/app/connections" go={go}>Connections</Link>
              <Link to="/app/company" go={go}>Company</Link>
            </>
          )}
        </nav>
        <TenantSwitcher />
        <button onClick={() => void auth.signOut()}>Sign out</button>
      </header>
      <AuthNotices />
      <main>{page}</main>
    </div>
  );
}
