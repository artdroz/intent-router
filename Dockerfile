# Multi-stage build: 
# Stage 1 compiles TypeScript (src/ + scripts/) to dist/,
# Stage 2 runs only the compiled output with production dependencies.
# The SAME image serves the app (dist/src/index.js), the migration Job
# (dist/scripts/migrate.js), and ops/cron scripts (dist/scripts/*.js).

# ====== Stage 1: build the app ======
FROM node:22-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ====== Stage 2: run the app ======
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/config ./config

USER node

EXPOSE 8080 8081

# Liveness probe: check if the app is running and responding to requests.
# /ready checks the DB, so leave it to k8s' readiness probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
