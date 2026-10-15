# Node.js 24 "Krypton", the active LTS line on 7 Oct 2026, pinned to the exact release and to the
# digest of its multi-architecture image (the digest the registry returned for this tag on
# 7 Oct 2026), so a rebuilt tag cannot change what the jury builds.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

LABEL org.opencontainers.image.title="Multilingual Review-Reply Triage" \
      org.opencontainers.image.authors="Chetan Gupta" \
      org.opencontainers.image.licenses="Apache-2.0"

# No LLM_* variable is set here: the endpoint, model name and key arrive at run time, from
# the environment of `make run`. With none of them the app runs on its offline fixture.
# APERTUS_IN_CONTAINER tells the server that "localhost" in LLM_BASE_URL is this container,
# not the host, so it points a loopback endpoint at host.docker.internal instead.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    APERTUS_IN_CONTAINER=1

WORKDIR /app

# Build time: the only step that contacts the network (the npm registry). Express and its
# dependencies only; no install scripts run.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# What the running server reads: its code, the seed reviews and the offline fixture's answers.
# The evaluation set, the tests and the documents stay out of the image.
COPY src ./src
COPY data/seed-reviews.json data/fake-provider-fixtures.json ./data/

# Files stay owned by root and read-only to the app; nothing is written at run time.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/', { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "src/server.js"]
