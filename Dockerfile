# Stremio Web — HomeIomp deployment image.
#
# Multi-stage: node build -> nginx static server on port 3000 (HomeIomp convention).
#
# The production build uses webpack's default `output.publicPath: 'auto'`, so every asset URL
# (scripts, styles, fonts, images, the wasm binary, the web worker, the service worker and the
# precache manifest) is resolved relative to the document / worker script at runtime. The image
# therefore serves the app from "/" and is mounted under a subpath by the reverse proxy, e.g.
#
#     redir /stremio /stremio/ 308
#     handle_path /stremio/* { reverse_proxy stremio-web:3000 }
#
# The trailing-slash redirect is required: relative asset resolution and the service worker scope
# both depend on the document living at /stremio/ rather than /stremio.

# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
# Node version comes from .nvmrc.
FROM node:20-alpine AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# git: webpack derives the asset directory name from the commit hash (cache busting).
RUN apk add --no-cache git \
    && corepack enable \
    && corepack prepare pnpm@10.25.0 --activate

WORKDIR /app

# pnpm-workspace.yaml + patches/ carry the `patchedDependencies` entry for
# @stremio/stremio-video (see patches/ for what it changes and why). They are inputs to `pnpm
# install`, so they must land before it or the install fails on an outdated lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

COPY . .

# Optional overrides. COMMIT_HASH short-circuits the `git rev-parse HEAD` lookup (useful when the
# build context has no .git); DEFAULT_STREAMING_SERVER_URL changes the streaming server a fresh
# profile starts with.
ARG COMMIT_HASH=""
ARG DEFAULT_STREAMING_SERVER_URL=""
ENV COMMIT_HASH=$COMMIT_HASH
ENV DEFAULT_STREAMING_SERVER_URL=$DEFAULT_STREAMING_SERVER_URL

RUN git config --global --add safe.directory /app 2>/dev/null || true
RUN pnpm build

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM nginx:alpine

LABEL org.opencontainers.image.title="Stremio Web" \
      org.opencontainers.image.description="Stremio Web served for HomeIomp under /stremio"

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:3000/index.html || exit 1

CMD ["nginx", "-g", "daemon off;"]
