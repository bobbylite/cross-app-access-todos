# Shared image for the `resource`, `chat`, and `config-editor` services — same
# dependency graph, different `command:` per service in docker-compose.yml.
#
# Runs from source via tsx, deliberately not compiled. src/resource-as/server.ts and
# src/chat/server.ts both resolve their static asset directories relative to the
# *source* file's location (dirname(fileURLToPath(import.meta.url))) — a compiled
# dist/ build would resolve those paths to somewhere that doesn't exist and 404 every
# static asset. The agent (deploy/agent.Dockerfile) has no static assets, so it
# compiles normally.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save tsx typescript

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/keys /app/data && chown -R node:node /app
USER node

EXPOSE 8081 8082 8083 8090

CMD ["npx", "tsx", "src/index.ts"]
