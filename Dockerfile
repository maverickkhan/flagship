# syntax=docker/dockerfile:1

# ============================================================
# deps: full install (includes prisma CLI + toolchain)
# ============================================================
FROM node:22-slim AS deps
WORKDIR /app
# openssl at build time too: prisma generate detects the SSL flavor when
# resolving engines — absent libssl it guesses openssl-1.1.x and the runtime
# stage (OpenSSL 3) cannot load the engine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ============================================================
# build: compile TS + generate Prisma client
# ============================================================
FROM deps AS build
COPY tsconfig.json nest-cli.json ./
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
RUN npm run build

# ============================================================
# dev: hot-reload target for docker-compose only
# ============================================================
FROM deps AS dev
COPY tsconfig.json nest-cli.json ./
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
EXPOSE 8080
CMD ["npm", "run", "start:dev"]

# ============================================================
# migrate: dedicated migration image (Cloud Run job target).
# The pruned API runtime has no prisma CLI; this stage keeps it.
# ============================================================
FROM node:22-slim AS migrate
ENV NODE_ENV=production
WORKDIR /app
# Prisma engines need libssl; node:22-slim ships without it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
# Strip the npm CLI bundled with the base image: not needed at runtime (the
# prisma binary is invoked directly) and its vendored deps carry CVEs
# (e.g. CVE-2026-13149 in brace-expansion) that fail the Trivy gate.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
USER node
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

# ============================================================
# runtime: pruned production API image
# ============================================================
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# The generated Prisma client lives in node_modules and is NOT produced by a
# pruned install — copy it from the build stage or the app boots dead.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/dist ./dist
# npm CLI removed post-install: runtime is `node dist/main.js`, npm is pure
# attack surface here and its vendored deps trip the Trivy HIGH gate
# (CVE-2026-13149 et al. in npm's own node_modules).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
USER node
EXPOSE 8080
# node:22-slim ships neither wget nor curl; Node 22 has global fetch.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
