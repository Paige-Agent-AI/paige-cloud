FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
ARG SOURCE_SHA
ARG PROOF_RELEASE
WORKDIR /app
COPY --chown=node:node server.mjs ./
USER node
ENV NODE_ENV=production SOURCE_SHA=${SOURCE_SHA} PROOF_RELEASE=${PROOF_RELEASE}
RUN node --input-type=module -e "import { makeHandler } from './server.mjs'; makeHandler(process.env)"
LABEL org.opencontainers.image.revision="${SOURCE_SHA}"
EXPOSE 8080 443
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
