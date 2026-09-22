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
RUN npm run build
FROM node:20-alpine AS runner
WORKDIR /app
LABEL org.opencontainers.image.title="H&H Media Guard" org.opencontainers.image.description="Safe audio language validation" org.opencontainers.image.source="https://github.com/PRO50347/hh-media-guard" org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production PORT=3938 HOSTNAME=0.0.0.0 CONFIG_DIR=/config ALLOW_DESTRUCTIVE_ACTIONS=false
RUN apk add --no-cache ffmpeg wget && addgroup -S guard && adduser -S guard -G guard && mkdir /config && chown guard:guard /config
COPY --from=build --chown=guard:guard /app/public ./public
COPY --from=build --chown=guard:guard /app/.next/standalone ./
COPY --from=build --chown=guard:guard /app/.next/static ./.next/static
USER guard
EXPOSE 3938
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://localhost:3938/api/health || exit 1
CMD ["node","server.js"]
