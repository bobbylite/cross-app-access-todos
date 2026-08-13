# The agent already compiles to dist/ and has no static assets, so unlike the shared
# node.Dockerfile it's built as a normal multi-stage image.
FROM node:22-slim AS build
WORKDIR /agent
COPY xaaagent/app/todos_agent/package*.json ./
RUN npm ci
COPY xaaagent/app/todos_agent/ ./
RUN npx tsc

FROM node:22-slim
WORKDIR /agent
ENV NODE_ENV=production
ENV PORT=8080
COPY xaaagent/app/todos_agent/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /agent/dist ./dist
USER node
EXPOSE 8080

# --env-file-if-exists (not --env-file): silently continues if /config/agent.env
# isn't mounted, since agentcore's own deployed runtime supplies env vars a different
# way and shouldn't hard-fail on a missing file that was never meant to exist there.
CMD ["node", "--env-file-if-exists=/config/agent.env", "dist/main.js"]
