FROM bluenviron/mediamtx:1.21.4@sha256:c730bccdbc8739f8f0c13cefe9bea8b61926f599b88fa4d0d229baa91846c7bc AS mediamtx
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
RUN apk add --no-cache ffmpeg tini && mkdir -p /app /recordings && chown node:node /recordings
COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx
WORKDIR /app
COPY --chown=node:node mediamtx.yml origin.mjs ./
USER node
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["node", "origin.mjs"]
