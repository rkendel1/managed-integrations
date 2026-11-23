# Convenience wrapper: sets SOURCE_COMMIT (immutable version id) and MI_REPO_DIR (maintenance mounts).
SHELL := /bin/bash
export SOURCE_COMMIT := $(shell git rev-parse HEAD)
export MI_REPO_DIR := $(CURDIR)
COMPOSE := docker compose --env-file .env

.PHONY: env build up down reset logs ps demo-failure e2e prod-up backup demo-adopted demo-reconcile demo-maintenance demo-onboarding

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

demo-onboarding: ## SLICE 5: a new customer connects, we discover their integration, they confirm, we protect and adapt it (run `make reset` first)
	$(COMPOSE) --profile demo exec -T api pnpm exec tsx apps/api/scripts/demo-onboarding.ts
