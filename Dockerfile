FROM node:20-alpine

WORKDIR /app

# Install against the lockfile first so a source-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production deps after the build — typescript/tsx/vitest are only
# needed to produce dist/.
RUN npm prune --omit=dev

# Block cursor and caches live here. Mount a volume at this path to keep them
# across deploys; without one the next cycle simply starts from a fresh
# MAX_LOOKBACK_BLOCKS window with a cold cache.
ENV STATE_DIR=/app/tmp
RUN mkdir -p /app/tmp

# No HTTP port — this is a worker.
CMD ["node", "dist/index.js"]
