import { useQuery } from '@tanstack/react-query';
import { Card, CardBody, CardHeader, Empty, ErrorNote, StatusBadge, Table, Td } from '@/components/ui';
import { callCapability } from '@/lib/capabilities';
import { fmtDate } from '@/lib/utils';

interface IntegrationsList {
  tenant: { id: string; name: string };
  integrations: Array<{
    id: string;
    tenantId: string;
    flowId: string;
    displayName: string;
    lifecycle: string;
    configVersion: number;
    createdAt: string;
    updatedAt: string;
  }>;
}

/**
 * Renders the durable result of the AppPort capability `integrations.list@1`.
 * The MCP projection of this same capability returns the same records.
 */
export function CustomerIntegrations() {
  const q = useQuery({
    queryKey: ['appport', 'integrations.list'],
    queryFn: () => callCapability<IntegrationsList>('integrations.list', {}),
  });

  if (q.isLoading) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-slate-500" data-testid="integrations-loading">
            Loading integrations…
          </p>
        </CardBody>
      </Card>
    );
  }
  if (q.error) return <ErrorNote error={q.error} />;
  const data = q.data;
  if (!data) return null;

  return (
    <Card data-testid="appport-integrations">
      <CardHeader
        title="Integrations"
        description={`Tenant ${data.tenant.name} · served by the AppPort capability integrations.list@1`}
      />
      <CardBody>
        {data.integrations.length === 0 ? (
          <Empty>No integrations exist for this tenant.</Empty>
        ) : (
          <Table head={['Name', 'Flow', 'Lifecycle', 'Config version', 'Updated']}>
            {data.integrations.map((integration) => (
              <tr key={integration.id} data-testid="integration-row">
                <Td>
                  <span data-testid="integration-id" className="hidden">
                    {integration.id}
                  </span>
                  {integration.displayName || integration.flowId}
                </Td>
                <Td className="font-mono text-xs">{integration.flowId}</Td>
                <Td>
                  <StatusBadge value={integration.lifecycle} />
                </Td>
                <Td>{integration.configVersion}</Td>
                <Td>{fmtDate(integration.updatedAt)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </CardBody>
    </Card>
  );
}
