FROM node:22-alpine AS base
WORKDIR /app

# Next.js phones home to Vercel at build/run; disable it everywhere (required for
# air-gap, harmless otherwise).
ENV NEXT_TELEMETRY_DISABLED=1

# Copy manifests first to get a cacheable dependency layer.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ── Development stage ──────────────────────────────────────────────────────
FROM base AS dev
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ── Production build stage ─────────────────────────────────────────────────
FROM base AS build
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
COPY . .
RUN npm run build

# ── Production runtime stage ───────────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules

EXPOSE 3000
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
CMD ["node_modules/.bin/next", "start"]
