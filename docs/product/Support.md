Managed Integrations — Master Application Integration Catalog

I’d build this as the initial market and engineering inventory for Managed Integrations, not as a promise that every connector will be supported immediately.

The catalog should cover applications that customers already depend on, whether they are:

* Sources: produce events or business data.
* Targets: receive data or business operations.
* Bidirectional: both produce and receive changes.
* Standalone dependencies: an application integrates directly with a provider, without being part of a source-to-target pipeline. SaaSKit → Stripe is our current example.

One architectural rule: an application is not inherently a source or a target. Its role depends on the business relationship being maintained.

The package column lists useful Node/npm starting points, not dependencies we should blindly adopt. Official SDKs are preferred where they exist; otherwise, OpenAPI-generated clients and thin adapters are candidates. The MCP column distinguishes vendor-maintained options from community implementations and cases where a server still needs investigation.

1. Payments, billing, and commerce

These are natural early targets because SaaSKit already gives us a real Stripe application integration, and Slice 6 established Stripe → QuickBooks.

Application	Typical role	npm package / implementation	MCP availability
Stripe	Both / standalone	stripe — official	Official Stripe MCP
PayPal	Both	PayPal REST APIs; SDK depends on product	Official MCP availability needs verification
Square	Both	square — official Node SDK	Investigate vendor/community
Adyen	Both	@adyen/api-library	Investigate
Braintree	Both	braintree	Investigate
Paddle	Both	@paddle/paddle-node-sdk	Investigate
Chargebee	Both	chargebee	Investigate
Recurly	Both	REST/OpenAPI adapter; verify current SDK	Investigate
Shopify	Both	@shopify/shopify-api — official	Shopify developer MCP; verify current scope
WooCommerce	Both	@woocommerce/woocommerce-rest-api	Community options
BigCommerce	Both	REST/OpenAPI adapter; verify SDK	Investigate
Magento / Adobe Commerce	Both	REST/OpenAPI adapter	Community options
Amazon Seller Central	Both	Selling Partner API client / OpenAPI	Investigate
Etsy	Both	REST/OpenAPI adapter	Investigate

2. Accounting, ERP, and financial operations

This is one of the most important categories because financial integrations have strong requirements for completeness, identity, idempotency, and independent reconciliation.

Application	Typical role	npm package / implementation	MCP availability
QuickBooks Online	Both	node-quickbooks (community); Intuit OAuth/API adapter	Intuit MCP implementation reported; verify official support
Xero	Both	xero-node	Xero MCP server available; verify publisher/version
NetSuite	Both	SuiteTalk REST/OpenAPI adapter	Investigate
Sage Intacct	Both	REST/Web Services adapter	Investigate
Sage Accounting	Both	REST/OpenAPI adapter	Investigate
Microsoft Dynamics 365 Business Central	Both	REST API / generated client	Investigate
SAP S/4HANA	Both	OData/OpenAPI adapters	Investigate
FreshBooks	Both	REST/OpenAPI adapter	Investigate
Wave	Both	GraphQL/API adapter	Investigate
Zoho Books	Both	REST/OpenAPI adapter	Investigate
BILL	Both	REST/OpenAPI adapter	Investigate
Expensify	Both	REST/API adapter	Investigate
Ramp	Both	API adapter	Investigate
Brex	Both	Official/maintained SDK; verify current package	Investigate

3. CRM, sales, and customer success

Application	Typical role	npm package / implementation	MCP availability
Salesforce	Both	jsforce	Official MCP availability needs verification
HubSpot	Both	@hubspot/api-client	Official HubSpot MCP
Pipedrive	Both	REST/OpenAPI adapter	Investigate
Zoho CRM	Both	REST/OpenAPI adapter	Investigate
Microsoft Dynamics 365 Sales	Both	Microsoft Dataverse/Web API	Investigate
Close	Both	REST/OpenAPI adapter	Investigate
Intercom	Both	intercom-client	Investigate
Zendesk	Both	node-zendesk	Investigate
Freshdesk	Both	REST/OpenAPI adapter	Investigate
Gorgias	Both	REST/OpenAPI adapter	Investigate
Front	Both	REST/OpenAPI adapter	Investigate

4. Communication, email, and notifications

Application	Typical role	npm package / implementation	MCP availability
Slack	Both	@slack/web-api	Official Slack MCP availability; verify current offering
Microsoft Teams	Both	@microsoft/microsoft-graph-client	Investigate
Discord	Both	discord.js	Community MCP options
Twilio	Both	twilio	Investigate
SendGrid	Both	@sendgrid/mail	Investigate
Resend	Both	resend	Investigate
Mailgun	Both	Official SDK/API	Investigate
Mailchimp	Both	@mailchimp/mailchimp_marketing	Investigate
Klaviyo	Both	REST/OpenAPI adapter	Investigate
Brevo	Both	REST/OpenAPI adapter	Investigate
Postmark	Both	postmark	Investigate

5. Productivity, documents, and collaboration

Application	Typical role	npm package / implementation	MCP availability
Google Workspace	Both	googleapis	Individual/community MCP servers; verify scope
Microsoft 365	Both	@microsoft/microsoft-graph-client	Microsoft MCP offerings vary by product
Notion	Both	@notionhq/client	Official/community MCP; verify current publisher
Airtable	Both	airtable	Community MCP options
Dropbox	Both	dropbox	Community MCP options
Box	Both	@box/sdk	Investigate
DocuSign	Both	docusign-esign	Investigate
Adobe Acrobat Sign	Both	REST/OpenAPI adapter	Investigate
Asana	Both	asana	Investigate
Trello	Both	REST/API adapter	Community options
Monday.com	Both	GraphQL/API adapter	Investigate
ClickUp	Both	REST/OpenAPI adapter	Investigate
Linear	Both	@linear/sdk	Investigate
Atlassian Jira	Both	jira.js	Official Atlassian MCP
Confluence	Both	jira.js / REST adapter	Official Atlassian MCP

6. Developer platforms, infrastructure, and observability

These matter both as customer integrations and as ways to maintain the software that customers already run.

Application	Typical role	npm package / implementation	MCP availability
GitHub	Both	@octokit/rest	Official GitHub MCP
GitLab	Both	@gitbeaker/rest	Community options
Bitbucket	Both	REST/OpenAPI adapter	Investigate
Vercel	Both	@vercel/sdk	Investigate
Netlify	Both	REST/OpenAPI adapter	Investigate
Cloudflare	Both	cloudflare	Investigate
AWS	Both	@aws-sdk/client-*	Individual/community MCP servers
Google Cloud	Both	@google-cloud/*	Investigate
Microsoft Azure	Both	@azure/*	Investigate
Supabase	Both	@supabase/supabase-js	Official/community MCP; verify scope
Sentry	Both	@sentry/* SDKs and REST API	Sentry MCP available
Datadog	Both	REST/OpenAPI adapter	Investigate
New Relic	Both	REST/GraphQL adapter	Investigate
PagerDuty	Both	REST/OpenAPI adapter	Investigate
incident.io	Both	REST/OpenAPI adapter	Investigate
LaunchDarkly	Both	launchdarkly-node-server-sdk	Investigate
Statsig	Both	Official Node SDK	Investigate

7. Data, analytics, and marketing

Application	Typical role	npm package / implementation	MCP availability
PostHog	Both	posthog-node	Official/community MCP; verify
Amplitude	Both	REST/API adapter	Investigate
Mixpanel	Both	REST/API adapter	Investigate
Segment	Both	@segment/analytics-node	Investigate
RudderStack	Both	@rudderstack/rudder-sdk-node	Investigate
Google Analytics	Both	@google-analytics/data	Investigate
Google Ads	Both	google-ads-api	Investigate
Meta Ads	Both	Marketing API adapter	Investigate
TikTok Ads	Both	Marketing API adapter	Investigate
BigQuery	Both	@google-cloud/bigquery	Investigate
Snowflake	Both	snowflake-sdk	Investigate
Databricks	Both	REST/SDK adapter	Investigate

8. HR, payroll, and workforce

Application	Typical role	npm package / implementation	MCP availability
Gusto	Both	REST/OpenAPI adapter	Investigate
Rippling	Both	API adapter	Investigate
Deel	Both	REST/OpenAPI adapter	Investigate
Workday	Both	SOAP/REST adapter	Investigate
BambooHR	Both	REST/OpenAPI adapter	Investigate
ADP	Both	REST/API adapter	Investigate
Paychex	Both	REST/API adapter	Investigate
Greenhouse	Both	REST/OpenAPI adapter	Investigate
Lever	Both	REST/OpenAPI adapter	Investigate

9. Industry and vertical applications

These are less likely to be first-wave connectors, but should be represented in the long-term catalog.

Category	Applications to consider	Implementation approach
Healthcare	Epic, athenahealth, DrChrono	FHIR, HL7, vendor APIs; specialized security and compliance
Insurance	Guidewire, Applied Epic	Vendor-specific APIs and event contracts
Property management	AppFolio, Buildium, Yardi	REST/API and partner integrations
Logistics	ShipStation, Shippo, EasyPost, UPS, FedEx	Official SDKs and carrier APIs
Inventory and fulfillment	Cin7, Fishbowl, ShipBob	REST/API adapters
Manufacturing	Odoo, SAP, Oracle ERP	REST, XML, OData, EDI
Education	Canvas LMS, Moodle, Blackboard	REST, LTI, event adapters
Travel and hospitality	Booking.com, Cloudbeds, Mews	Partner APIs and webhooks
Legal	Clio, PracticePanther	REST/OpenAPI adapters
Construction	Procore, Autodesk Construction Cloud	REST/OpenAPI adapters
Real estate	Follow Up Boss, kvCORE	REST/API adapters

These verticals should not be treated as ordinary CRUD integrations. They can involve specialized identity, regulated information, domain-specific transaction models, and non-HTTP protocols.

10. Integration infrastructure and protocols

These aren’t customer applications, but they are important to making the catalog scalable.

Technology	Purpose	npm / implementation
OpenAPI	API discovery and contract ingestion	@apidevtools/swagger-parser, openapi-typescript
HTTP	Generic API execution	fetch / undici
OAuth 2.0	Delegated provider authentication	openid-client
Webhooks	Provider event ingestion	Shared webhook verification framework
GraphQL	Schema and operation discovery	graphql, @graphql-codegen/*
SOAP	Legacy enterprise systems	soap
OData	Microsoft and enterprise APIs	Generated clients / HTTP adapter
EDI / X12	Supply chain and financial exchange	Specialized EDI parser/translator
HL7 / FHIR	Healthcare interoperability	FHIR client and protocol-specific tooling
SFTP / CSV / XML	File-based integrations	ssh2, CSV/XML parsers
MCP	AI-accessible capability interface	Official or community MCP server, or an AppPort-backed MCP adapter

11. MCP strategy: an important distinction

I would not make Managed Integrations depend on MCP servers to execute customer integrations.

There are three separate things:

* Provider SDK: Executes API operations in application code.
* OpenAPI contract: Describes the provider’s HTTP API.
* MCP server: Exposes selected operations to an AI client through the MCP protocol.

An MCP server may help us discover, inspect, or operate an application. But it is not automatically a suitable production integration runtime. We need deterministic execution, durable transaction state, authorization, idempotency, recovery, and independent verification.

My recommendation is to expose Managed Integrations’ own capabilities through AppPort and, where useful, MCP. That way an agent can inspect or request maintenance without becoming the authority over execution.

MCP availability worth investigating first

Known vendor-published options

* Stripe — Stripe MCP⁠￼.
* GitHub — GitHub MCP server⁠￼.
* Atlassian — Atlassian remote MCP⁠￼.
* HubSpot — vendor MCP offering; verify current documentation and scope.
* Shopify — developer MCP offering; verify supported operations.

QuickBooks and Xero also have MCP implementations reported in the ecosystem, but I would verify the actual publisher, repository, release status, and supported operations before calling either officially supported. Nexatoolbox +1

12. Which integrations should we actually prioritize?

I would not attempt to support all of these at once. I would use the following order to drive adoption and validate the reusable integration machinery.

Wave 1 — Prove the core

Immediate

Stripe, Shopify, QuickBooks Online, Xero, NetSuite, HubSpot, Salesforce, Slack, Google Workspace, Microsoft 365.

Proves payments, commerce, accounting, CRM, messaging, and productivity.

Wave 2 — Expand business coverage

Square, PayPal, Paddle, Chargebee, Sage Intacct, Dynamics 365, Zendesk, Intercom, Airtable, Notion, Asana, DocuSign, Twilio, Resend, GitHub.

Covers common SaaS and small-business workflows.

Wave 3 — Enterprise and vertical

SAP, Workday, ADP, Ramp, Brex, ServiceNow, AWS, Azure, Google Cloud, Datadog, Procore, Epic, logistics and EDI providers.

Higher implementation and operational complexity; prioritize based on customer demand.

13. The catalog should become a durable product artifact

I would maintain this as structured data rather than letting this table become the permanent source of truth.

Each application should have a record containing:

Field	Why it matters
Application identity	Stable provider identity
Business category	Discovery and prioritization
Supported roles	Source, target, bidirectional, standalone
API protocols	REST, GraphQL, SOAP, OData, EDI, etc.
OpenAPI specification	URL, version, hash, provenance
Official npm SDK	Package, publisher, version, license
Alternative client	Generated or community implementation
MCP server	URL/package, publisher, transport, status
Authentication	OAuth, API key, certificate, etc.
Webhook support	Events, signatures, replay behavior
Change detection	Versioning, changelogs, schema changes
Verification	What can independently establish success
Adoption status	Candidate, inspected, implemented, validated, supported
Limitations	Known gaps and unsupported operations

Important: a package existing on npm does not establish that it is official, maintained, complete, or safe to use. Those need separate verification. For example, Stripe publishes its stripe Node SDK, and Square recommends its official server-side SDKs. GitHub +1 Other useful starting points include the OpenSDKs prepackaged SDK catalog and the available connector catalogs, but those are discovery sources, not endorsements. openintegrations/openSDKs · GitHub +2

14. My recommendation for the actual build

I would make three deliverables from this inventory:

* Application catalog: the complete provider registry, including SDK, OpenAPI, MCP, protocol, and authentication metadata.
* Adoption tooling: inspect an application, ingest its API contracts, discover capabilities, and generate an initial AppPort-compatible adapter.
* Managed integration lifecycle: maintain the application and provider independently, detect changes, correct, recover, and verify outcomes.

The most important thing is that the catalog must distinguish available from actually supported. A listed SDK or MCP server is not a working Managed Integrations connector.

The long-term target is that adding a new application becomes an adoption exercise, not a new integration software project.
