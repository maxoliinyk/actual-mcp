# syntax=docker/dockerfile:1

# ---- Builder ----
FROM node:24-slim AS builder

# Reason: better-sqlite3 13.x has no prebuilt binaries and needs a native toolchain.
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./
RUN npm run build

# Reason: keep compiled native modules without shipping the compiler in production.
RUN npm prune --omit=dev

# ---- Release ----
FROM node:24-slim AS release

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build

ENV NODE_ENV=production
ENV TMPDIR=/tmp
ENV ACTUAL_DATA_DIR=/tmp/actual-data

EXPOSE 3000
CMD ["node", "build/index.js", "--sse", "--enable-write", "--enable-bearer"]
