# syntax=docker/dockerfile:1

# Stage 1: Build frontend (native, no emulation)
FROM --platform=$BUILDPLATFORM node:20-slim AS frontend
WORKDIR /app
RUN npm i -g pnpm
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY src/ src/
COPY index.html vite.config.ts tsconfig.json ./
COPY public/ public/
RUN pnpm build

# Stage 2: Cross-compile Rust backend for the requested platform (native, no emulation)
FROM --platform=$BUILDPLATFORM rust:1-bookworm AS backend
ARG TARGETARCH
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config perl python3-pip gcc-aarch64-linux-gnu \
    unixodbc-dev \
    && pip3 install --break-system-packages ziglang \
    && cargo install cargo-zigbuild \
    && rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /tmp/arm64-odbc && cd /tmp/arm64-odbc \
    && curl -sLO http://deb.debian.org/debian/pool/main/u/unixodbc/libodbc2_2.3.11-2+deb12u1_arm64.deb \
    && curl -sLO http://deb.debian.org/debian/pool/main/u/unixodbc/libodbcinst2_2.3.11-2+deb12u1_arm64.deb \
    && curl -sLO http://deb.debian.org/debian/pool/main/u/unixodbc/unixodbc-dev_2.3.11-2+deb12u1_arm64.deb \
    && dpkg -x libodbc2_*.deb / \
    && dpkg -x libodbcinst2_*.deb / \
    && dpkg -x unixodbc-dev_*.deb / \
    && rm -rf /tmp/arm64-odbc

# Copy dependency manifests only and create dummy sources to pre-compile dependencies.
# This layer is cached by GHA as long as Cargo.toml/Cargo.lock don't change.
COPY Cargo.toml Cargo.lock ./
COPY crates/dbx-core/Cargo.toml crates/dbx-core/
COPY src-web/Cargo.toml src-web/
COPY src-tauri/Cargo.toml src-tauri/
RUN mkdir -p crates/dbx-core/src && echo '' > crates/dbx-core/src/lib.rs \
    && mkdir -p src-web/src && echo 'fn main() {}' > src-web/src/main.rs \
    && mkdir -p src-tauri/src && echo 'fn main() {}' > src-tauri/src/main.rs && echo 'pub fn run() {}' > src-tauri/src/lib.rs

COPY src-tauri/build.rs src-tauri/
COPY src-tauri/tauri.conf.json src-tauri/

RUN case "$TARGETARCH" in \
      amd64) rust_target=x86_64-unknown-linux-gnu; lib_arch=x86_64-linux-gnu ;; \
      arm64) rust_target=aarch64-unknown-linux-gnu; lib_arch=aarch64-linux-gnu ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    LIBRARY_PATH="/usr/lib/$lib_arch" \
    PKG_CONFIG_PATH="/usr/lib/$lib_arch/pkgconfig" \
    PKG_CONFIG_SYSROOT_DIR="/" \
    RUSTFLAGS="-L native=/usr/lib/$lib_arch" \
    cargo zigbuild --release -p dbx-web --target "$rust_target" || true

# Copy real sources and rebuild (only application code recompiles)
COPY crates/ crates/
COPY src-web/ src-web/

# Docker COPY preserves original file timestamps, which may be older than the
# dummy-source binary compiled above. Touch all .rs files so cargo detects the
# source change and recompiles instead of reusing the dummy binary.
RUN find crates/ src-web/ -name '*.rs' -exec touch {} +

RUN case "$TARGETARCH" in \
      amd64) rust_target=x86_64-unknown-linux-gnu; lib_arch=x86_64-linux-gnu ;; \
      arm64) rust_target=aarch64-unknown-linux-gnu; lib_arch=aarch64-linux-gnu ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    LIBRARY_PATH="/usr/lib/$lib_arch" \
    PKG_CONFIG_PATH="/usr/lib/$lib_arch/pkgconfig" \
    PKG_CONFIG_SYSROOT_DIR="/" \
    RUSTFLAGS="-L native=/usr/lib/$lib_arch" \
    cargo zigbuild --release -p dbx-web --target "$rust_target" && \
    mkdir -p "/out/linux/$TARGETARCH" && \
    cp "/app/target/$rust_target/release/dbx-web" "/out/linux/$TARGETARCH/"

# Stage 3: Final image
FROM debian:bookworm-slim
ARG TARGETPLATFORM
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 unixodbc && rm -rf /var/lib/apt/lists/*
COPY --from=backend /out/${TARGETPLATFORM}/dbx-web /usr/local/bin/
COPY --from=frontend /app/dist /app/static
ENV DBX_STATIC_DIR=/app/static
ENV DBX_DATA_DIR=/app/data
EXPOSE 4224
CMD ["dbx-web"]
