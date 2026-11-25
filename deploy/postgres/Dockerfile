# Presence postgres: PostGIS (venue geofences, TR-16) + pgvector (FR-09/TECH-09
# linking search space) + h3-pg (TR-16 native H3 column for market config).
# Both extensions build from pinned upstream tags; the base image ships no
# build tools, so they are added and removed in one layer. with_llvm=no skips
# JIT bitcode (keeps the build independent of the alpine clang/llvm package
# versions); the extensions themselves are unaffected.
FROM postgis/postgis:17-3.5-alpine

ARG PGVECTOR_VERSION=v0.8.0
ARG H3PG_VERSION=v4.2.1

RUN apk add --no-cache --virtual .pgvector-build \
      git make gcc musl-dev postgresql17-dev \
    && git clone --depth 1 --branch "$PGVECTOR_VERSION" \
      https://github.com/pgvector/pgvector.git /tmp/pgvector \
    && make -C /tmp/pgvector with_llvm=no \
    && make -C /tmp/pgvector install with_llvm=no \
    && rm -rf /tmp/pgvector \
    && apk del .pgvector-build

# h3-pg vendors the H3 core as a submodule and needs cmake + a C++ toolchain.
RUN apk add --no-cache --virtual .h3-build \
      git cmake make gcc g++ musl-dev postgresql17-dev \
    && git clone --depth 1 --branch "$H3PG_VERSION" \
      --recurse-submodules --shallow-submodules \
      https://github.com/uber/h3-pg.git /tmp/h3-pg \
    && cmake -S /tmp/h3-pg -B /tmp/h3-pg/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/h3-pg/build \
    && cmake --install /tmp/h3-pg/build \
    && rm -rf /tmp/h3-pg \
    && apk del .h3-build

# Backup toolchain (SEC-11/INF-18/NFR-24): age for the dual-recipient
# encryption every backup artefact goes through, plus the archive/backup/
# retention/rehearsal scripts the deploy manifests wire in.
RUN apk add --no-cache age
COPY backup/ /usr/local/bin/presence-backup/
RUN chmod +x /usr/local/bin/presence-backup/*.sh
