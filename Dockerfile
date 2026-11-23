# syntax=docker/dockerfile:1
# Managed Integrations — one image for api / worker / migrate, plus a `maintenance` target.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG DOCKER_CLI_IMAGE=docker:29-cli

FROM ${DOCKER_CLI_IMAGE} AS dockercli

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# Optional extra CA bundle for TLS-intercepting proxies (BuildKit secret `extra_ca`; used only at
# build time, never stored in the image).
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi; \
    npm install -g pnpm@10.28.0
WORKDIR /app
COPY . .
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile
RUN pnpm --filter @mi/web build
# The baseline implementation artifact is built from exactly this source tree.
ARG SOURCE_COMMIT=
RUN if [ -n "$SOURCE_COMMIT" ]; then SOURCE_COMMIT=$SOURCE_COMMIT pnpm exec tsx scripts/build-baseline-artifact.ts baseline-artifact; \
    else echo "WARNING: SOURCE_COMMIT not set; no baseline artifact (maintenance cannot run)"; mkdir -p baseline-artifact; fi

FROM build AS runtime
# Dependencies are kept as installed (tsx executes TypeScript directly; see docs/operations/OPERATIONS.md).
ENV NODE_ENV=production WEB_DIST_DIR=/app/apps/web/dist ARTIFACT_DIR=/data/artifacts BASELINE_ARTIFACT_DIR=/app/baseline-artifact
RUN mkdir -p /data/artifacts && chown -R node:node /data /app/baseline-artifact
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1
CMD ["pnpm", "exec", "tsx", "apps/api/src/main.ts"]

# Maintenance worker: needs git (worktrees), ripgrep (search tool) and the docker CLI (sandbox).
# It is deliberately given NO credential encryption keys.
FROM build AS maintenance
RUN --mount=type=secret,id=extra_ca,required=false \
    APTOPT=""; \
    if [ -s /run/secrets/extra_ca ]; then \
      sed -i 's#http://deb.debian.org#https://deb.debian.org#g' /etc/apt/sources.list.d/debian.sources; \
      cp /run/secrets/extra_ca /tmp/build-extra-ca.crt && chmod 0644 /tmp/build-extra-ca.crt; \
      APTOPT="-o Acquire::https::CAInfo=/tmp/build-extra-ca.crt"; \
      if [ -n "${HTTPS_PROXY:-}" ]; then APTOPT="$APTOPT -o Acquire::https::Proxy=$HTTPS_PROXY"; fi; \
    fi; \
    apt-get $APTOPT update && apt-get $APTOPT install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/* /tmp/build-extra-ca.crt && git config --system --add safe.directory '*'
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
ENV NODE_ENV=production WORKER_ROLE=maintenance ARTIFACT_DIR=/data/artifacts
HEALTHCHECK NONE
CMD ["pnpm", "exec", "tsx", "apps/worker/src/main.ts"]
