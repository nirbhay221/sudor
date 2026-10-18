# Sudor in a container, for anyone who would rather not install Node.
#
#   docker build -t sudor . && docker run -p 8789:8789 sudor
#
# Nothing else is needed: no keys, no account, no database. The server reads the
# forecast for each registered place on a timer and holds it in memory.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# The scheduled alert check (src/sweep.ts, started by src/lambda.ts), as a Lambda image. infra/ builds this
# target; locally, docker-compose.yml runs it with the emulator the base image carries.
#
#   docker build --target sweep --provenance=false -t sudor-sweep .
FROM public.ecr.aws/lambda/nodejs:22 AS sweep
COPY package.json package-lock.json ${LAMBDA_TASK_ROOT}/
RUN cd ${LAMBDA_TASK_ROOT} && npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ${LAMBDA_TASK_ROOT}/dist
# Lambda's file system is read-only outside /tmp, and these are only ever a local log.
ENV SUDOR_OUTBOX=/tmp/outbox.jsonl SUDOR_IMPACT=/tmp/impact.json SUDOR_DATA=/tmp/people.json
CMD ["dist/lambda.handler"]

# The server, and the default target.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY web ./web
COPY ui ./ui
COPY skills ./skills
COPY assets ./assets
# Profiles live here, and they are health details. Mount a volume over it only
# if you mean to keep them, and keep that volume private.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV PORT=8789
EXPOSE 8789
# /health reports how old the forecast in memory is, which is the thing that
# actually matters about this process being up.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8789/health || exit 1
CMD ["node", "dist/server.js"]
