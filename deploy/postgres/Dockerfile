# Presence postgres: PostGIS (venue geofences, TR-16) + pgvector (FR-09/TECH-09
# linking search space). pgvector is built from the pinned upstream tag; the
# base image ships no build tools, so they are added and removed in one layer.
# with_llvm=no skips JIT bitcode (keeps the build independent of the alpine
# clang/llvm package versions); the extension itself is unaffected.
FROM postgis/postgis:17-3.5-alpine

ARG PGVECTOR_VERSION=v0.8.0

RUN apk add --no-cache --virtual .pgvector-build \
      git make gcc musl-dev postgresql17-dev \
    && git clone --depth 1 --branch "$PGVECTOR_VERSION" \
      https://github.com/pgvector/pgvector.git /tmp/pgvector \
    && make -C /tmp/pgvector with_llvm=no \
    && make -C /tmp/pgvector install with_llvm=no \
    && rm -rf /tmp/pgvector \
    && apk del .pgvector-build
