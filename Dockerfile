# syntax=docker/dockerfile:1.9

ARG NODE_BUILD_BASE=node:24.18.0-trixie-slim@sha256:5301bbf5e8046148348b1dea15436326f43c579031f8d76654a631225bdfe467
ARG DISTROLESS_BASE=gcr.io/distroless/nodejs24-debian13:nonroot-amd64@sha256:b1386d556b478c420927eb212236bfb31be9834a4549850a060a6351f7fff514

FROM ${NODE_BUILD_BASE} AS dependencies
WORKDIR /app
COPY --chmod=0644 package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev --no-audit --no-fund

FROM dependencies AS build
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_BUILD_BASE} AS production-dependencies
WORKDIR /app
COPY --chmod=0644 package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

FROM ${DISTROLESS_BASE} AS runtime
ARG OCI_SOURCE=https://github.com/arthurportodev/genesis-platform-api
ARG OCI_REVISION=local
ARG OCI_VERSION=0.1.0
ARG OCI_CREATED=1970-01-01T00:00:00Z
LABEL org.opencontainers.image.source=${OCI_SOURCE} \
      org.opencontainers.image.revision=${OCI_REVISION} \
      org.opencontainers.image.version=${OCI_VERSION} \
      org.opencontainers.image.created=${OCI_CREATED} \
      org.opencontainers.image.title="Genesis Platform API" \
      org.opencontainers.image.description="Hardened production runtime for the Genesis Platform API" \
      org.opencontainers.image.licenses="UNLICENSED"

WORKDIR /app
ENV NODE_ENV=production \
    TZ=UTC \
    PORT=3000

COPY --from=production-dependencies --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/dist ./dist
COPY --chown=65532:65532 --chmod=0644 package.json ./package.json

USER nonroot
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const port=process.env.PORT||'3000';fetch('http://127.0.0.1:'+port+'/api/v1/health/live').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["dist/main.js"]
