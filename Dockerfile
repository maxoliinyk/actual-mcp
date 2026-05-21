# syntax=docker/dockerfile:1

# ---- Builder ----
FROM node:22-slim AS builder

# Reason: better-sqlite3 (dep of @actual-app/api) requires native compilation tools.
# node:22-slim lacks python3/make/g++, so prebuild-install fallback to node-gyp fails without them.
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

# ---- Release ----
FROM node:22-slim AS release

# Reason: Production npm ci also compiles better-sqlite3 native addon from source.
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/build ./build

ENV NODE_ENV=production
ENV TMPDIR=/tmp
ENV ACTUAL_DATA_DIR=/tmp/actual-data

RUN npm ci --omit=dev

# Reason: Remove build tools after npm ci to keep image smaller.
RUN apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

EXPOSE 3000
CMD ["node", "build/index.js", "--sse", "--enable-write"]
