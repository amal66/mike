FROM node:22-alpine AS base
WORKDIR /app

# Install dependencies separately from source so Docker can cache this layer.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ── Development stage ──────────────────────────────────────────────────────
FROM base AS dev
COPY . .
EXPOSE 3001
CMD ["npx", "tsx", "watch", "src/index.ts"]

# ── Production build stage ─────────────────────────────────────────────────
FROM base AS build
COPY . .
RUN npm run build

# ── Production runtime stage ───────────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules

EXPOSE 3001
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]

# ── Air-gapped runtime ─────────────────────────────────────────────────────
# Adds LibreOffice (+fonts) so DOCX→PDF conversion works offline — lib/convert.ts
# shells out to `soffice`, which the lean image lacks (conversion silently no-ops
# today). Also bundles the SQL baseline + runner so the `migrate` init container
# applies them with no CLI. A fresh database takes schema.sql (staged here as the
# lexically-first "migration"), per schema.sql's own header; the dated files in
# backend/migrations are deltas for pre-existing databases and are not staged.
# Build target: mike-api:airgapped.
FROM production AS production-airgapped
USER root
RUN apk add --no-cache \
        libreoffice \
        ttf-dejavu ttf-liberation font-noto \
    && rm -rf /var/cache/apk/*
# Migration runner + ordered SQL for the migrate init container.
COPY scripts/migrate.mjs ./scripts/migrate.mjs
COPY schema.sql ./migrations/00000000000000_baseline.sql
CMD ["node", "dist/index.js"]
