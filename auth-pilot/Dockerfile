FROM node:22-bookworm@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb AS build
WORKDIR /src
COPY upstream.commit /cloud/upstream.commit
RUN set -eu; upstream="$(cat /cloud/upstream.commit)"; \
    printf '%s\n' "$upstream" | grep -Ex '[a-f0-9]{40}'; \
    git init -q; \
    git fetch -q --depth=1 https://github.com/Paige-Agent-AI/Paige-Agent-AI.git "$upstream"; \
    git checkout -q --detach FETCH_HEAD; \
    test "$(git rev-parse HEAD)" = "$upstream"; \
    npm ci --no-audit --no-fund
COPY auth-pilot/prepare.mjs /cloud/auth-pilot/prepare.mjs
COPY auth-pilot/frontend /cloud/auth-pilot/frontend
RUN node /cloud/auth-pilot/prepare.mjs /src && node_modules/.bin/vite build --config pilot-vite.config.mjs

FROM node:22-bookworm@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb
ARG CLOUD_COMMIT
ARG UPSTREAM_COMMIT
WORKDIR /pilot
LABEL org.opencontainers.image.source="https://github.com/Paige-Agent-AI/paige-cloud-preview" \
      org.opencontainers.image.revision="$CLOUD_COMMIT" \
      ai.paige.frontend.revision="$UPSTREAM_COMMIT" \
      ai.paige.environment="ant-178-auth-pilot"
COPY upstream.commit /tmp/upstream.commit
RUN test "$UPSTREAM_COMMIT" = "$(cat /tmp/upstream.commit)" \
    && printf '%s\n' "$CLOUD_COMMIT" | grep -Ex '[a-f0-9]{40}' \
    && printf '{"environment":"ant-178-auth-pilot","cloudCommit":"%s","frontendCommit":"%s"}\n' "$CLOUD_COMMIT" "$UPSTREAM_COMMIT" > release.json
COPY auth-pilot/server.mjs auth-pilot/supabase.mjs ./
COPY --from=build /src/pilot-dist/assets ./dist/assets
COPY --from=build /src/pilot-dist/pilot-index.html ./dist/index.html
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
