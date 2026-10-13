# Faultline web app, replay mode by default.
#
#   docker build -t faultline .          # from the repo root
#   docker run --rm -p 3000:3000 faultline
#
# Live mode: add -e FAULTLINE_MODE=live -e LLM_URL=... -e EMBED_URL=... -e VLLM_API_KEY=...

FROM node:24-slim AS build
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
# The build copies what the app serves out of results/ and prompts/.
COPY results ./results
COPY prompts ./prompts
COPY apps/web ./apps/web
WORKDIR /repo/apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN CI=true pnpm prune --prod

FROM node:24-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web ./
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
