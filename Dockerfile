FROM node:22-bookworm@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb AS build
WORKDIR /src
COPY upstream.commit /tmp/upstream.commit
RUN set -eu; upstream="$(cat /tmp/upstream.commit)"; \
    printf '%s\n' "$upstream" | grep -Ex '[a-f0-9]{40}'; \
    git init -q; \
    git fetch -q --depth=1 https://github.com/Paige-Agent-AI/Paige-Agent-AI.git "$upstream"; \
    git checkout -q --detach FETCH_HEAD; \
    test "$(git rev-parse HEAD)" = "$upstream"; \
    npm ci --no-audit --no-fund

ARG CLOUD_COMMIT
ARG UPSTREAM_COMMIT
COPY scripts/prepare-preview.mjs /tmp/prepare-preview.mjs
COPY docker/preview-app.tsx /src/src/App.tsx
RUN test "$UPSTREAM_COMMIT" = "$(cat /tmp/upstream.commit)" \
    && node /tmp/prepare-preview.mjs prepare "$UPSTREAM_COMMIT" "$CLOUD_COMMIT" \
    && NODE_OPTIONS=--max-old-space-size=4096 npm run build \
    && node /tmp/prepare-preview.mjs verify "$UPSTREAM_COMMIT" "$CLOUD_COMMIT"

FROM nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236
ARG CLOUD_COMMIT
ARG UPSTREAM_COMMIT
LABEL org.opencontainers.image.source="https://github.com/Paige-Agent-AI/paige-cloud-preview" \
      org.opencontainers.image.revision="$CLOUD_COMMIT" \
      org.opencontainers.image.version="$CLOUD_COMMIT" \
      ai.paige.frontend.revision="$UPSTREAM_COMMIT" \
      ai.paige.environment="cloud-preview"
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /src/dist/ /usr/share/nginx/html/
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["nginx", "-g", "daemon off;"]
CMD []
