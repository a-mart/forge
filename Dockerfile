# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.18.0

FROM node:${NODE_VERSION}-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

ARG VITE_FORGE_WEB_BASE=same-origin
ARG VITE_FORGE_DEFAULT_SURFACE=collab
ARG VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS=true
ENV VITE_FORGE_WEB_BASE=${VITE_FORGE_WEB_BASE}
ENV VITE_FORGE_DEFAULT_SURFACE=${VITE_FORGE_DEFAULT_SURFACE}
ENV VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS=${VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS}

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV NODE_ENV=production
ENV FORGE_HOST=0.0.0.0
ENV FORGE_PORT=47287
ENV FORGE_RUNTIME_TARGET=collaboration-server
ENV FORGE_DATA_DIR=/var/lib/forge

RUN corepack enable

WORKDIR /app
COPY --from=builder /app /app

EXPOSE 47287
VOLUME ["/var/lib/forge"]

CMD ["node", "apps/backend/dist/index.js"]
