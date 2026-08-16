# Single-stage image that runs the TS source directly via tsx.
# This matches the current `npm start` (tsx src/index.ts) and `db:migrate:prod`
# (tsx scripts/migrate.ts), so the SAME image serves both the app container and
# the migration Job.
# Optimization (later): split into a multi-stage tsc build and run `node dist/index.js`.

FROM node:22-slim

WORKDIR /app

# Dependencies first, for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Everything else — includes drizzle/ (SQL migrations) and scripts/.
COPY . .

EXPOSE 3000

CMD ["npm", "start"]
