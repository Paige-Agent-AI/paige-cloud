FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS base
WORKDIR /app
USER node

FROM base AS verify
COPY --chown=node:node . .
RUN node --test

FROM base
LABEL org.opencontainers.image.source="https://github.com/Paige-Agent-AI/paige-cloud-preview"
COPY --chown=node:node server.mjs projects.mjs memberships.mjs status.mjs release-ledger.json ./
COPY --chown=node:node public/ ./public/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
