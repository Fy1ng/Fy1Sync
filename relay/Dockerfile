ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --chown=node:node dist/relay/relay.cjs ./relay.cjs
USER node
ENV RELAY_HOST=0.0.0.0 RELAY_PORT=5081 RELAY_DATA_DIR=/data
CMD ["node", "relay.cjs"]
