# ---- Builder ----
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . ./
RUN npm run build

# ---- Release ----
FROM node:22-slim AS release

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/build ./build

ENV NODE_ENV=production
ENV TMPDIR=/tmp
ENV ACTUAL_DATA_DIR=/tmp/actual-data

RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

EXPOSE 3000
CMD ["node", "build/index.js", "--sse", "--enable-write"]
