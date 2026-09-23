FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN MG_BUILD=1 npm run build
FROM node:20-alpine AS runner
WORKDIR /app
ARG APP_VERSION=0.2.1
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="H&H Media Guard" org.opencontainers.image.description="Safe audio language validation" org.opencontainers.image.source="https://github.com/PRO50347/hh-media-guard" org.opencontainers.image.licenses="MIT" org.opencontainers.image.version="${APP_VERSION}" org.opencontainers.image.revision="${VCS_REF}"
ENV NODE_ENV=production PORT=3938 HOSTNAME=0.0.0.0 CONFIG_DIR=/config ALLOW_DESTRUCTIVE_ACTIONS=false APP_VERSION=${APP_VERSION} NEXT_MANUAL_SIG_HANDLE=true NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache ffmpeg wget su-exec && addgroup -S guard && adduser -S guard -G guard && mkdir /config && chown guard:guard /config
COPY --from=build --chown=guard:guard /app/public ./public
COPY --from=build --chown=guard:guard /app/.next/standalone ./
COPY --from=build --chown=guard:guard /app/.next/static ./.next/static
COPY --from=build --chown=guard:guard /app/scripts/config-backup.mjs ./scripts/config-backup.mjs
COPY scripts/config-init.mjs scripts/docker-entrypoint.sh ./scripts/
USER root
ENTRYPOINT ["/bin/sh", "/app/scripts/docker-entrypoint.sh"]
EXPOSE 3938
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1
CMD ["node","server.js"]
