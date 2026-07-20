.DEFAULT_GOAL := dev

PNPM ?= pnpm
TAURI_DEV_PORT ?= 1420

.PHONY: help install docs-install check-tauri-dev-port dev dev-fast dev-web dev-backend build package docs docs-build check test cargo-check-fast cargo-test-fast db db-list db-verify db-down db-reset db-check db-completion

export DB
export DB_VERSION
export DB_BIND_ADDRESS
export DB_PORT
export DB_PASSWORD
export FOLLOW
export CONFIRM

node_modules/.modules.yaml: package.json pnpm-lock.yaml
	$(PNPM) install --frozen-lockfile

docs/node_modules/.modules.yaml: docs/package.json docs/pnpm-lock.yaml
	cd docs && $(PNPM) install --frozen-lockfile --ignore-workspace

help:
	@printf '%s\n' 'DBX development targets:'
	@printf '%s\n' ''
	@printf '%s\n' 'App:'
	@printf '  %-23s %s\n' 'make' 'Start the local desktop development environment'
	@printf '  %-23s %s\n' 'make dev' 'Start the local desktop development environment'
	@printf '  %-23s %s\n' 'make dev-fast' 'Start Tauri dev without default Rust features'
	@printf '  %-23s %s\n' 'make dev-web' 'Start the web frontend development server'
	@printf '  %-23s %s\n' 'make dev-backend' 'Start the web backend development server'
	@printf '  %-23s %s\n' 'make build' 'Run type checks and build the desktop frontend'
	@printf '  %-23s %s\n' 'make package' 'Build the desktop app package'
	@printf '%s\n' ''
	@printf '%s\n' 'Docs:'
	@printf '  %-23s %s\n' 'make docs' 'Start the documentation site development server'
	@printf '  %-23s %s\n' 'make docs-build' 'Build the documentation site'
	@printf '  %-23s %s\n' 'make docs-install' 'Install documentation site dependencies'
	@printf '%s\n' ''
	@printf '%s\n' 'Checks:'
	@printf '  %-23s %s\n' 'make check' 'Run project checks'
	@printf '  %-23s %s\n' 'make test' 'Run project tests'
	@printf '  %-23s %s\n' 'make cargo-check-fast' 'Run Rust check without default features'
	@printf '  %-23s %s\n' 'make cargo-test-fast' 'Run Rust tests without default features'
	@printf '%s\n' ''
	@printf '%s\n' 'Database test environments:'
	@printf '  %-23s %s\n' 'make db-list' 'List available database versions'
	@printf '  %-23s %s\n' 'make db DB=mysql@8.4' 'Start and print DBX connection fields'
	@printf '  %-23s %s\n' 'make db-verify DB=mysql@8.4' 'Start and run smoke checks'
	@printf '  %-23s %s\n' 'make db-down DB=mysql@8.4' 'Stop an environment'
	@printf '  %-23s %s\n' 'make db-reset DB=mysql@8.4 CONFIRM=1' 'Delete containers and data'
	@printf '  %-23s %s\n' 'make db-check' 'Validate every recipe and Compose file'
	@printf '  %-23s %s\n' 'make db-completion' 'Show Bash/Zsh completion setup'
	@printf '%s\n' ''
	@printf '%s\n' 'Setup:'
	@printf '  %-23s %s\n' 'make install' 'Install root project dependencies'

install:
	$(PNPM) install --frozen-lockfile

docs-install:
	cd docs && $(PNPM) install --frozen-lockfile --ignore-workspace

check-tauri-dev-port:
	@if lsof -nP -iTCP:$(TAURI_DEV_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "Port $(TAURI_DEV_PORT) is already in use. DBX Tauri dev requires http://localhost:$(TAURI_DEV_PORT)."; \
		echo ""; \
		lsof -nP -iTCP:$(TAURI_DEV_PORT) -sTCP:LISTEN; \
		echo ""; \
		echo "Stop the process above, then run make dev again. Example: kill <PID>"; \
		exit 1; \
	fi

dev: node_modules/.modules.yaml check-tauri-dev-port
	$(PNPM) dev:tauri

dev-fast: node_modules/.modules.yaml check-tauri-dev-port
	$(PNPM) tauri dev -- --no-default-features

dev-web: node_modules/.modules.yaml
	$(PNPM) dev:web

dev-backend: node_modules/.modules.yaml
	$(PNPM) dev:backend

build: node_modules/.modules.yaml
	$(PNPM) build:checked

package: node_modules/.modules.yaml
	$(PNPM) tauri build

docs: docs/node_modules/.modules.yaml
	cd docs && ./node_modules/.bin/next dev --hostname 127.0.0.1

docs-build: docs/node_modules/.modules.yaml
	cd docs && ./node_modules/.bin/next build && node scripts/generate-sitemap.mjs

check: node_modules/.modules.yaml
	$(PNPM) check

test: node_modules/.modules.yaml
	$(PNPM) test

cargo-check-fast:
	cargo check --no-default-features

cargo-test-fast:
	cargo test --no-default-features

db-list:
	@$(PNPM) db:env -- list

db:
	@$(PNPM) db:env -- start

db-verify:
	@$(PNPM) db:env -- verify

db-down:
	@$(PNPM) db:env -- down

db-reset:
	@$(PNPM) db:env -- reset

db-check:
	@$(PNPM) db:env -- check

db-completion:
	@$(PNPM) db:env -- completion
