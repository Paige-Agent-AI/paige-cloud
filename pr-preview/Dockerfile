FROM node:22-bookworm@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb AS build
WORKDIR /src
ARG PULL_REQUEST
ARG FRONTEND_COMMIT
RUN set -eu; \
    printf '%s\n' "$PULL_REQUEST" | grep -Ex '[1-9][0-9]{0,9}'; \
    printf '%s\n' "$FRONTEND_COMMIT" | grep -Ex '[a-f0-9]{40}'; \
    git init -q; \
    git fetch -q --depth=1 https://github.com/Paige-Agent-AI/Paige-Agent-AI.git "refs/pull/$PULL_REQUEST/head"; \
    git checkout -q --detach FETCH_HEAD; \
    test "$(git rev-parse HEAD)" = "$FRONTEND_COMMIT"

# Keep the canonical routes and entry points. Supply only inert browser configuration.
RUN rm -f .env .env.* \
    && printf '%s\n' 'VITE_SUPABASE_URL=https://preview-backend.invalid' \
       'VITE_SUPABASE_PROJECT_ID=preview-backend' 'VITE_SUPABASE_PUBLISHABLE_KEY=preview-disabled' \
       'VITE_SUPABASE_ANON_KEY=preview-disabled' > .env.production \
    && npm ci --no-audit --no-fund \
    && GITHUB_SHA="$FRONTEND_COMMIT" NODE_OPTIONS=--max-old-space-size=4096 npm run build
ARG CLOUD_COMMIT
COPY app-host/prepare-frontend.mjs /tmp/prepare-frontend.mjs
RUN node /tmp/prepare-frontend.mjs release "$FRONTEND_COMMIT" "$CLOUD_COMMIT"

FROM nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236
ARG PULL_REQUEST
ARG FRONTEND_COMMIT
ARG CLOUD_COMMIT
LABEL org.opencontainers.image.source="https://github.com/Paige-Agent-AI/paige-cloud-preview" \
      org.opencontainers.image.revision="$CLOUD_COMMIT" \
      ai.paige.frontend.revision="$FRONTEND_COMMIT" \
      ai.paige.preview.pull-request="$PULL_REQUEST" \
      ai.paige.environment="pull-request-preview"
COPY pr-preview/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /src/dist/ /usr/share/nginx/html/
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["nginx", "-g", "daemon off;"]
CMD []
