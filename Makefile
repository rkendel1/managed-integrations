# Convenience wrapper: sets SOURCE_COMMIT (immutable version id) and MI_REPO_DIR (maintenance mounts).
SHELL := /bin/bash
export SOURCE_COMMIT := $(shell git rev-parse HEAD)
export MI_REPO_DIR := $(CURDIR)
COMPOSE := docker compose --env-file .env

.PHONY: env build up down logs ps seed demo-failure test e2e prod-up backup restore-check

env:            ## create .env with a fresh encryption key (once)
	@test -f .env || (cp .env.example .env && sed -i "s#^CREDENTIAL_ENCRYPTION_KEYS=.*#CREDENTIAL_ENCRYPTION_KEYS=k1:$$(openssl rand -base64 32)#" .env && echo "created .env")

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
