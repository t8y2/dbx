#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_RECIPES_ROOT = join(REPO_ROOT, 'deploy', 'database');
const DEFAULT_MAKEFILE_PATH = join(REPO_ROOT, 'Makefile');
const DEFAULT_PASSWORD = '123456';
const DEFAULT_DATABASE = 'dbx';

export function discoverRecipes(root = DEFAULT_RECIPES_ROOT) {
  if (!existsSync(root)) return [];
  const recipes = [];
  for (const database of readdirSync(root, { withFileTypes: true })) {
    if (!database.isDirectory()) continue;
    const databaseDir = join(root, database.name);
    for (const version of readdirSync(databaseDir, { withFileTypes: true })) {
      if (!version.isDirectory()) continue;
      const recipePath = join(databaseDir, version.name, 'recipe.json');
      if (!existsSync(recipePath)) continue;
      const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
      recipes.push({ ...recipe, directory: dirname(recipePath), recipePath });
    }
  }
  return recipes.sort((a, b) => `${a.database}/${a.displayVersion}`.localeCompare(`${b.database}/${b.displayVersion}`, 'en'));
}

export function recipeSelector(recipe) {
  return `${recipe.database}@${recipe.displayVersion}`;
}

export function formatTable(headers, rows) {
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => String(row[index] ?? '').length),
  ));
  const renderRow = (row) => row.map((value, index) => {
    const text = String(value ?? '');
    return index === row.length - 1 ? text : text.padEnd(widths[index]);
  }).join('  ');

  return [headers, ...rows].map(renderRow).join('\n');
}

export function discoverMakeTargets(makefilePath = DEFAULT_MAKEFILE_PATH) {
  if (!existsSync(makefilePath)) return [];
  const source = readFileSync(makefilePath, 'utf8').replace(/\\\r?\n/g, ' ');
  const targets = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\.PHONY:\s*(.+)$/);
    if (match) targets.push(...match[1].trim().split(/\s+/));
  }
  return [...new Set(targets)];
}

export function platformForArchitecture(architecture = process.arch) {
  if (architecture === 'x64') return 'linux/amd64';
  if (architecture === 'arm64') return 'linux/arm64';
  return null;
}

export function architectureWarning(recipe, architecture = process.arch) {
  const platform = platformForArchitecture(architecture);
  if (!platform || recipe.platforms?.includes(platform)) return null;
  return `${recipe.image} does not support ${platform}. Docker must use ${recipe.platforms.join(', ')} emulation and startup may be slower.`;
}

function printQuickStart(recipes) {
  console.log('Database test environments');
  console.log('Copy one command to start an environment:');
  console.log('');
  for (const recipe of recipes) console.log(`  make db DB=${recipeSelector(recipe)}`);
  console.log('');
  console.log('Optional parameters:');
  console.log('  DB_BIND_ADDRESS=<ip>   Override the default bind address (127.0.0.1).');
  console.log('  DB_PORT=<port>          Override the default host port.');
  console.log('  DB_PASSWORD=<password>  Override the default password (123456).');
  console.log('');
  console.log('Next steps: make db-verify DB=<product>@<version>, make db-down DB=<product>@<version>');
  console.log('Tab completion: make db-completion');
}

function printCompletionSetup() {
  console.log('Bash:       source deploy/database/completion/dbx-make.bash');
  console.log('Zsh:        autoload -Uz compinit && compinit && source deploy/database/completion/_dbx-make.zsh');
  console.log('PowerShell: . .\\deploy\\database\\completion\\Dbx.Make.ps1');
}

export function resolveRecipe(recipes, database, version) {
  if (!database) throw new Error('DB is required. Run `make db-list` to see available environments.');
  const matches = recipes.filter((item) => item.database === database && (!version || item.displayVersion === version || item.version === version));
  if (matches.length === 0) throw new Error(`No database environment found for ${database}${version ? ` ${version}` : ''}.`);
  if (matches.length > 1) throw new Error(`${database} has multiple versions (${matches.map((item) => item.displayVersion).join(', ')}). Use DB=${database}@<version> (or DB_VERSION).`);
  return matches[0];
}

export function parseDatabaseSelection(selection, explicitVersion) {
  if (!selection) return { database: selection, version: explicitVersion };
  const selectorIndex = selection.lastIndexOf('@');
  if (selectorIndex === -1) return { database: selection, version: explicitVersion };

  const database = selection.slice(0, selectorIndex);
  const selectorVersion = selection.slice(selectorIndex + 1);
  if (!database || !selectorVersion) throw new Error('DB must use the format <product>@<version>, for example DB=mysql@8.4.');
  if (explicitVersion && explicitVersion !== selectorVersion) {
    throw new Error(`DB version ${selectorVersion} conflicts with DB_VERSION=${explicitVersion}.`);
  }
  return { database, version: explicitVersion || selectorVersion };
}

export function assertResetConfirmed(value) {
  if (value !== '1') throw new Error('Reset deletes the environment volume. Re-run with CONFIRM=1.');
}

export function expectedContainerName(recipe) {
  return `dbx-${recipe.database}-${recipe.displayVersion}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
}

export function validateRecipe(recipe) {
  const errors = [];
  for (const field of ['database', 'version', 'displayVersion', 'service', 'connection', 'smoke', 'shell', 'defaultPort']) {
    if (recipe[field] === undefined) errors.push(`missing ${field}`);
  }
  if (!recipe.image || !/^[^\s]+:[^\s]+$/.test(recipe.image)) errors.push('image must be a pinned image reference');
  if (recipe.connection?.host !== '127.0.0.1') errors.push('connection.host must be 127.0.0.1');
  if (!Number.isInteger(recipe.defaultPort) || recipe.defaultPort < 1 || recipe.defaultPort > 65534) {
    errors.push('defaultPort must be an integer between 1 and 65534');
  } else if (recipe.connection?.port !== recipe.defaultPort + 1) {
    errors.push('connection.port must be defaultPort + 1');
  }
  if (recipe.connection?.authentication === 'none') {
    if (recipe.connection.password !== undefined) errors.push('unauthenticated recipes must not declare connection.password');
  } else if (recipe.connection?.password !== DEFAULT_PASSWORD) errors.push(`connection.password must be ${DEFAULT_PASSWORD}`);
  if (recipe.database === 'redis' ? recipe.connection?.database !== 0 : recipe.connection?.database !== DEFAULT_DATABASE) {
    errors.push(`connection.database must be ${recipe.database === 'redis' ? '0 for Redis' : DEFAULT_DATABASE}`);
  }
  if (!Array.isArray(recipe.platforms) || recipe.platforms.length === 0) errors.push('platforms must not be empty');
  else if (recipe.platforms.some((platform) => !['linux/amd64', 'linux/arm64'].includes(platform))) {
    errors.push('platforms contains an unsupported platform');
  }
  if (basename(recipe.directory) !== recipe.displayVersion || basename(dirname(recipe.directory)) !== recipe.database) {
    errors.push('recipe directory must match database/displayVersion');
  }
  const composePath = join(recipe.directory, 'compose.yaml');
  if (!existsSync(composePath)) errors.push('missing compose.yaml');
  else {
    const compose = readFileSync(composePath, 'utf8');
    if (!compose.includes(`container_name: ${expectedContainerName(recipe)}`)) {
      errors.push(`compose.yaml container_name must be ${expectedContainerName(recipe)}`);
    }
    if (/image:\s*[^\n]*:latest(?:\s|$)/.test(compose)) errors.push('compose.yaml must not use latest');
    if (!/healthcheck\s*:/.test(compose)) errors.push('compose.yaml must define a healthcheck');
    if (!/^volumes\s*:/m.test(compose)) errors.push('compose.yaml must define a named volume');
    if (!compose.includes(`image: ${recipe.image}`)) errors.push('compose.yaml image must match recipe.image');
    if (recipe.platforms?.length === 1 && !compose.includes(`platform: ${recipe.platforms[0]}`)) {
      errors.push(`single-platform image must set compose platform to ${recipe.platforms[0]}`);
    }
    if (!allPortMappingsDefaultToLoopback(compose)) {
      errors.push('compose.yaml ports must default every mapping to 127.0.0.1 via DB_BIND_ADDRESS');
    }
    if (!serviceHasNamedVolume(compose, recipe.service)) errors.push('target service must mount a named volume');
    if (!compose.includes(`\${DB_PORT:-${recipe.connection?.port}}:${recipe.defaultPort}`)) {
      errors.push('compose.yaml must default DB_PORT to connection.port and target defaultPort');
    }
  }
  const initDirectory = join(recipe.directory, 'init');
  if (!existsSync(initDirectory) || readdirSync(initDirectory).length === 0) errors.push('init directory must contain a file');
  if (!Array.isArray(recipe.smoke?.steps) || recipe.smoke.steps.length === 0) errors.push('smoke.steps must not be empty');
  for (const step of recipe.smoke?.steps ?? []) {
    if (!step.name || !Array.isArray(step.command) || step.command.length === 0) errors.push('every smoke step needs a name and command');
    if (typeof step.expect !== 'string' || step.expect.length === 0) errors.push('every smoke step needs an expected output');
  }
  if (!Array.isArray(recipe.shell) || recipe.shell.length === 0) errors.push('shell must be a non-empty command array');
  if (recipe.bootstrap !== undefined) {
    if (!recipe.bootstrap || typeof recipe.bootstrap !== 'object') errors.push('bootstrap must be an object');
    if (!recipe.bootstrap?.check || !Array.isArray(recipe.bootstrap.check.command) || recipe.bootstrap.check.command.length === 0 || typeof recipe.bootstrap.check.expect !== 'string' || recipe.bootstrap.check.expect.length === 0) {
      errors.push('bootstrap.check needs a command and expected output');
    }
    if (!Array.isArray(recipe.bootstrap?.steps) || recipe.bootstrap.steps.length === 0) errors.push('bootstrap.steps must not be empty');
    for (const step of recipe.bootstrap?.steps ?? []) {
      if (!step.name || !Array.isArray(step.command) || step.command.length === 0) errors.push('every bootstrap step needs a name and command');
      if (typeof step.expect !== 'string' || step.expect.length === 0) errors.push('every bootstrap step needs an expected output');
    }
  }
  return errors;
}

function indentation(line) {
  return line.length - line.trimStart().length;
}

function serviceBlock(compose, service) {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s{2}${service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`).test(line));
  if (start === -1) return [];
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentation(line) <= 2) break;
    block.push(line);
  }
  return block;
}

export function allPortMappingsDefaultToLoopback(compose) {
  const lines = compose.split(/\r?\n/);
  let portsIndent = null;
  let foundMapping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const lineIndent = indentation(line);
    if (/^ports\s*:/.test(trimmed)) {
      portsIndent = lineIndent;
      const inlineMappings = trimmed.match(/['\"]([^'\"]+)['\"]/g) ?? [];
      if (inlineMappings.length > 0) {
        foundMapping = true;
        if (inlineMappings.some((mapping) => !mapping.slice(1, -1).startsWith('${DB_BIND_ADDRESS:-127.0.0.1}:'))) return false;
      }
      continue;
    }
    if (portsIndent === null) continue;
    if (trimmed && lineIndent <= portsIndent) {
      portsIndent = null;
      continue;
    }
    if (!trimmed.startsWith('-')) continue;
    foundMapping = true;
    const mapping = trimmed.slice(1).trim().replace(/^['\"]|['\"]$/g, '');
    if (!mapping.startsWith('${DB_BIND_ADDRESS:-127.0.0.1}:')) return false;
  }
  return foundMapping;
}

export function serviceHasNamedVolume(compose, service) {
  const block = serviceBlock(compose, service);
  let volumesIndent = null;
  for (const line of block) {
    const trimmed = line.trim();
    const lineIndent = indentation(line);
    if (/^volumes\s*:/.test(trimmed)) {
      volumesIndent = lineIndent;
      continue;
    }
    if (volumesIndent === null) continue;
    if (trimmed && lineIndent <= volumesIndent) {
      volumesIndent = null;
      continue;
    }
    if (!trimmed.startsWith('-')) continue;
    const mount = trimmed.slice(1).trim().replace(/^['\"]|['\"]$/g, '');
    if (/^[A-Za-z0-9][A-Za-z0-9_.-]*:/.test(mount) && !mount.startsWith('./') && !mount.startsWith('../')) return true;
  }
  return false;
}

function composeArgs(recipe, ...args) {
  const project = (process.env.DB_PROJECT || `dbx-${basename(REPO_ROOT)}-${recipe.database}-${recipe.displayVersion}`).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return ['compose', '--project-name', project, '--file', join(recipe.directory, 'compose.yaml'), ...args];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? REPO_ROOT, env: process.env, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout}` : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.${detail}`);
  }
  return options.capture ? `${result.stdout ?? ''}${result.stderr ?? ''}` : '';
}

function runCompose(recipe, args, options) {
  return run('docker', composeArgs(recipe, ...args), options);
}

function tryRunCompose(recipe, args) {
  const result = spawnSync('docker', composeArgs(recipe, ...args), { cwd: REPO_ROOT, env: process.env, encoding: 'utf8', stdio: 'pipe' });
  if (result.error) throw result.error;
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

export function expandSmokeCommand(command, recipe, environment = process.env) {
  const values = {
    DB_PASSWORD: environment.DB_PASSWORD || recipe.connection.password,
    DB_PORT: environment.DB_PORT || String(recipe.connection.port),
  };
  return command.map((value) => value.replace(/\$\{(DB_PASSWORD|DB_PORT)\}/g, (_, name) => values[name]));
}

function ensureBootstrap(recipe) {
  if (!recipe.bootstrap) return;
  // Keep one-shot setup synchronous after Compose health checks so --wait cannot return before credentials exist.
  const checkCommand = expandSmokeCommand(recipe.bootstrap.check.command, recipe);
  const check = tryRunCompose(recipe, ['exec', '-T', recipe.service, ...checkCommand]);
  if (check.ok && check.output.includes(recipe.bootstrap.check.expect)) return;

  for (const step of recipe.bootstrap.steps) {
    const command = expandSmokeCommand(step.command, recipe);
    const output = runCompose(recipe, ['exec', '-T', recipe.service, ...command], { capture: true });
    if (!output.includes(step.expect)) throw new Error(`Bootstrap check did not contain expected text: ${step.expect}\n${output}`);
    console.log(`OK   ${step.name}`);
  }
}

function printConnection(recipe) {
  const connection = { ...recipe.connection };
  if (process.env.DB_PORT) connection.port = Number(process.env.DB_PORT);
  if (process.env.DB_PASSWORD) connection.password = process.env.DB_PASSWORD;
  console.log(`${recipe.name} (${recipe.version})`);
  for (const [key, value] of Object.entries(connection)) console.log(`${key}: ${value}`);
  if (recipe.notes) console.log(`notes: ${recipe.notes}`);
  const warning = architectureWarning(recipe);
  if (warning) console.warn(`warning: ${warning}`);
}

function checkRecipes(recipes) {
  let failed = false;
  for (const recipe of recipes) {
    const errors = validateRecipe(recipe);
    if (errors.length) {
      failed = true;
      console.error(`FAIL ${recipe.database}/${recipe.displayVersion}: ${errors.join('; ')}`);
      continue;
    }
    const result = spawnSync('docker', composeArgs(recipe, 'config', '--format', 'json'), {
      encoding: 'utf8',
      env: { ...process.env, DB_BIND_ADDRESS: '' },
    });
    if (result.error?.code === 'ENOENT') {
      console.log(`OK   ${recipe.database}/${recipe.displayVersion} (static checks; Docker unavailable)`);
    } else if (result.status !== 0) {
      failed = true;
      console.error(`FAIL ${recipe.database}/${recipe.displayVersion}: docker compose config failed\n${result.stderr}`);
    } else {
      try {
        validateRenderedCompose(recipe, JSON.parse(result.stdout));
        console.log(`OK   ${recipe.database}/${recipe.displayVersion}`);
      } catch (error) {
        failed = true;
        console.error(`FAIL ${recipe.database}/${recipe.displayVersion}: ${error.message}`);
      }
    }
  }
  if (failed) throw new Error('Database environment checks failed.');
}

export function validateRenderedCompose(recipe, rendered) {
  const service = rendered.services?.[recipe.service];
  if (!service) throw new Error('rendered Compose config is missing the target service');
  if (service.container_name !== expectedContainerName(recipe)) {
    throw new Error(`rendered target service container_name must be ${expectedContainerName(recipe)}`);
  }
  if (!service.healthcheck?.test) throw new Error('rendered target service is missing a healthcheck');
  const ports = service.ports ?? [];
  if (ports.length === 0 || ports.some((port) => typeof port !== 'object' || port.host_ip !== '127.0.0.1')) {
    throw new Error('rendered target service has a port mapping that does not default to 127.0.0.1');
  }
  const volumes = service.volumes ?? [];
  if (!volumes.some((volume) => typeof volume === 'object' && volume.type === 'volume')) {
    throw new Error('rendered target service does not mount a named volume');
  }
}

export function main(argv = process.argv.slice(2)) {
  const [command = 'list', positionalDatabase, positionalVersion] = argv.filter((argument) => argument && argument !== '--');
  const recipes = discoverRecipes();

  if (command === 'list') {
    console.log(formatTable(
      ['DATABASE', 'VERSION', 'IMAGE', 'PLATFORMS'],
      recipes.map((recipe) => [recipe.database, recipe.displayVersion, recipe.image, recipe.platforms.join(',')]),
    ));
    return;
  }
  if (command === 'quick-start') return printQuickStart(recipes);
  if (command === 'completion') return printCompletionSetup();
  if (command === 'selectors') {
    for (const recipe of recipes) console.log(recipeSelector(recipe));
    return;
  }
  if (command === 'make-targets') {
    for (const target of discoverMakeTargets()) console.log(target);
    return;
  }
  if (command === 'check') return checkRecipes(recipes);

  const { database, version } = parseDatabaseSelection(process.env.DB || positionalDatabase, process.env.DB_VERSION || positionalVersion);

  if (command === 'start' && !database) return printQuickStart(recipes);

  const recipe = resolveRecipe(recipes, database, version);
  switch (command) {
    case 'info':
      printConnection(recipe);
      break;
    case 'start':
    case 'up':
      runCompose(recipe, ['up', '-d', '--wait']);
      ensureBootstrap(recipe);
      printConnection(recipe);
      break;
    case 'status':
      runCompose(recipe, ['ps']);
      break;
    case 'logs':
      runCompose(recipe, process.env.FOLLOW === '1' ? ['logs', '--follow'] : ['logs']);
      break;
    case 'shell':
      runCompose(recipe, ['exec', recipe.service, ...expandSmokeCommand(recipe.shell, recipe)]);
      break;
    case 'verify':
      runCompose(recipe, ['up', '-d', '--wait']);
      ensureBootstrap(recipe);
      for (const step of recipe.smoke.steps) {
        const command = expandSmokeCommand(step.command, recipe);
        const output = runCompose(recipe, ['exec', '-T', recipe.service, ...command], { capture: true });
        if (step.expect && !output.includes(step.expect)) throw new Error(`Smoke check did not contain expected text: ${step.expect}\n${output}`);
        console.log(`OK   ${step.name}`);
      }
      break;
    case 'down':
      runCompose(recipe, ['down', '--remove-orphans']);
      break;
    case 'reset':
      assertResetConfirmed(process.env.CONFIRM);
      runCompose(recipe, ['down', '--volumes', '--remove-orphans']);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
