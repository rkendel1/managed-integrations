# Convenience wrapper.
#   app-*  : the primary application, System B on FeltKit (systems/b). Needs Node >= 22.12, npm and pnpm (simulators).
#   others : System A, the PostgreSQL/Docker reference implementation; sets SOURCE_COMMIT (immutable version id)
#            and MI_REPO_DIR (maintenance mounts).
SHELL := /bin/bash
export SOURCE_COMMIT := $(shell git rev-parse HEAD)
export MI_REPO_DIR := $(CURDIR)
COMPOSE := docker compose --env-file .env
B := systems/b
B_SECRETS ?= $(CURDIR)/$(B)/.env.scenarios

.PHONY: app-install app-secrets app-dev app-test app-scenarios app-e2e app-check env build up down reset logs ps demo-failure e2e prod-up backup demo-adopted demo-reconcile demo-maintenance demo-onboarding demo-stripe demo-applications

# ---------------------------------------------------------------- the primary application (System B)

app-install:    ## install System B and the provider simulators
	pnpm install --frozen-lockfile
	cd $(B) && npm ci

app-secrets:    ## create systems/b/.env.scenarios once: the simulators' secrets and a fresh keyring (gitignored)
	@test -f $(B_SECRETS) || { umask 077; { \
	  echo "FELTKIT_CREDENTIAL_MI_KEYRING=k1:$$(openssl rand -base64 32)"; \
	  echo "FELTKIT_CREDENTIAL_SHOPIFY_CLIENT_SECRET=fixture-shopify-client-secret"; \
	  echo "FELTKIT_CREDENTIAL_QBO_CLIENT_SECRET=qbo-fixture-secret"; \
	  echo "FELTKIT_CREDENTIAL_REPAIR_AGENT=repair:$$(openssl rand -hex 16)"; } > $(B_SECRETS); echo "created $(B_SECRETS)"; }

app-dev: app-secrets ## DESTROY B's development state; start B (http://127.0.0.1:3100) and its simulators (50xx)
	MI_B_SECRETS=$(B_SECRETS) $(B)/scripts/reset.sh

app-test:       ## B's tests (a fresh FeltDB per test; no servers needed)
	cd $(B) && npm test

app-scenarios: app-secrets ## reset B and run every shared scenario (S1-S10); evidence in docs/evidence/runs/system-b
	@mkdir -p $(B)/.feltkit
	MI_B_SECRETS=$(B_SECRETS) $(B)/scripts/scenarios.sh > $(B)/.feltkit/scenarios.log 2>&1 || { tail -30 $(B)/.feltkit/scenarios.log; exit 1; }
	@grep -E "^===|ALL PASSED" $(B)/.feltkit/scenarios.log

app-e2e: app-dev ## reset B and run its browser journeys
	pnpm exec playwright test -c $(B)/e2e/playwright.config.ts --trace off

app-check:      ## typecheck, prebuilt-artifact freshness, FeltKit's code classification
	cd $(B) && npm run typecheck && node scripts/build-artifacts.ts --check && npx feltkit measure --write >/dev/null && npx feltkit measure --check

# ---------------------------------------------------------------- System A (reference implementation)

env:            ## create .env with a fresh encryption key (once)
	@test -f .env || (cp .env.example .env && echo "created .env")
	@# `sed -i` needs a backup suffix on macOS/BSD sed, so pass one and delete it (portable to GNU).
	@if grep -q '^CREDENTIAL_ENCRYPTION_KEYS=.*REPLACE_WITH_BASE64_32_BYTES' .env; then \
	  sed -i.bak "s#^CREDENTIAL_ENCRYPTION_KEYS=.*#CREDENTIAL_ENCRYPTION_KEYS=k1:$$(openssl rand -base64 32)#" .env && \
	  rm -f .env.bak && echo "generated encryption key in .env"; \
	fi

build: env      ## build images (runtime + maintenance)
	$(COMPOSE) --profile demo build

up: env         ## start the full demo stack (with deterministic fixtures)
	$(COMPOSE) --profile demo up -d --build
	@echo "UI: http://localhost:$${API_PORT:-3000}  (customer@acme.test / customer-demo-password, operator@managed-integrations.test / operator-demo-password)"

down:           ## stop the stack (keeps volumes)
	$(COMPOSE) --profile demo down

logs:
	$(COMPOSE) --profile demo logs -f --tail=100

ps:
	$(COMPOSE) --profile demo ps

demo-failure:   ## end-to-end failure demo against the running stack (ARGS=--auto-approve to script the approval click)
	$(COMPOSE) --profile demo exec -T worker pnpm exec tsx scripts/demo-failure.ts $(ARGS)

prod-up: env    ## production on a VPS (HTTPS via Caddy, backups, no fixtures)
	$(COMPOSE) -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build

backup:
	$(COMPOSE) -f docker-compose.yml -f deploy/docker-compose.prod.yml exec backup /bin/sh /backup.sh

reset:          ## DESTROY demo data (volumes) and start fresh; fixtures keep state in memory only
	$(COMPOSE) --profile demo down -v
	$(MAKE) up

demo-adopted:   ## SLICE 2: adopted shopify-erp-order-sync operated through AppPort/MCP (run `make reset` first)
	$(COMPOSE) --profile demo exec -T api pnpm exec tsx apps/api/scripts/demo-adopted.ts

demo-reconcile: ## SLICE 3: detect an order whose webhook never arrived, recover it via AppPort/MCP, verify NetSuite
	$(COMPOSE) --profile demo exec -T api pnpm exec tsx apps/api/scripts/demo-reconcile.ts

demo-maintenance: ## SLICE 4: a provider change is detected, fixed, verified and reported to the customer (run `make reset` first)
	$(COMPOSE) --profile demo exec -T api pnpm exec tsx apps/api/scripts/demo-maintenance.ts

demo-stripe: ## SLICE 6: the second integration (Stripe → QuickBooks, adopted ledgerly) on the shared mechanisms (run `make reset` first)
	$(COMPOSE) --profile demo exec -T api pnpm exec tsx apps/api/scripts/demo-stripe.ts

demo-applications: ## SLICE 7: two provider-dependent applications (Stripe, QuickBooks) adopted and maintained (run `make reset` first)
	$(COMPOSE) --profile demo exec -T api pnpm exec tsx apps/api/scripts/demo-applications.ts

demo-onboarding: ## SLICE 5: a new customer connects, we discover their integration, they confirm, we protect and adapt it (run `make reset` first)
	$(COMPOSE) --profile demo exec -T api pnpm exec tsx apps/api/scripts/demo-onboarding.ts
