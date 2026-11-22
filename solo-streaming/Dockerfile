FROM bluenviron/mediamtx:1.21.4@sha256:c730bccdbc8739f8f0c13cefe9bea8b61926f599b88fa4d0d229baa91846c7bc AS mediamtx
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runtime
WORKDIR /app
RUN apk add --no-cache curl tini && mkdir /recordings && chown node:node /recordings
COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY auth.mjs events.mjs media.mjs mcp.mjs server.mjs start.mjs mediamtx.yml ./
USER node
EXPOSE 8080 1936
ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["node", "start.mjs"]

FROM runtime AS verify
USER root
RUN apk add --no-cache ffmpeg
USER node

FROM runtime
