FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vision-monitor/package.json vision-monitor/package-lock.json ./vision-monitor/
RUN npm ci --prefix vision-monitor
COPY . .
RUN npm run build && npm --prefix vision-monitor run build \
    && npm prune --omit=dev && npm --prefix vision-monitor prune --omit=dev

FROM node:22-bookworm-slim AS runtime

# Debian provides Python 3.11 and glibc wheels for optional BGE memory setup.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates nginx python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/local /app/data /app/assets/references /app/public/models \
    && chown -R node:node /app/local /app/data /app/assets/references /app/public/models \
    && chmod +x /app/docker/start.sh

ENV NODE_ENV=production \
    PORT=8787 \
    WAIFU_DATA_DIR=/app/data \
    WAIFU_LOCAL_DIR=/app/local
USER node
EXPOSE 5173 5174
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["node", "docker/healthcheck.js"]
CMD ["bash", "/app/docker/start.sh"]
