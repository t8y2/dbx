# Stage 1: Build frontend
FROM node:20-slim AS frontend
WORKDIR /app
RUN npm i -g pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY src/ src/
COPY index.html vite.config.ts tsconfig.json ./
COPY tailwind.config.* postcss.config.* ./
RUN pnpm build

# Stage 2: Build Rust backend
FROM rust:1-bookworm AS backend
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY src-web/ src-web/
# Create a dummy src-tauri to satisfy workspace (not built)
RUN mkdir -p src-tauri/src && echo 'fn main() {}' > src-tauri/src/main.rs && echo 'pub fn run() {}' > src-tauri/src/lib.rs
COPY src-tauri/Cargo.toml src-tauri/
COPY src-tauri/build.rs src-tauri/
COPY src-tauri/tauri.conf.json src-tauri/
RUN cargo build --release -p dbx-web

# Stage 3: Final image
FROM debian:bookworm-slim
COPY --from=backend /app/target/release/dbx-web /usr/local/bin/
COPY --from=frontend /app/dist /app/static
ENV DBX_STATIC_DIR=/app/static
ENV DBX_DATA_DIR=/app/data
EXPOSE 4224
CMD ["dbx-web"]
