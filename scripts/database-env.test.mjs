import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DEFAULT_RECIPES_ROOT, allPortMappingsDefaultToLoopback, architectureWarning, assertResetConfirmed, discoverMakeTargets, discoverRecipes, expandSmokeCommand, expectedContainerName, formatTable, parseDatabaseSelection, platformForArchitecture, recipeSelector, resolveRecipe, serviceHasNamedVolume, validateRecipe, validateRenderedCompose } from './database-env.mjs';

const bashAvailable = spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;
const zshAvailable = spawnSync('zsh', ['--version'], { stdio: 'ignore' }).status === 0;
const dockerComposeAvailable = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;

function fixture(database, version) {
  const root = mkdtempSync(join(tmpdir(), 'dbx-db-env-'));
  const directory = join(root, database, version);
  mkdirSync(join(directory, 'init'), { recursive: true });
  writeFileSync(join(directory, 'init', '001-smoke.txt'), 'fixture initialization');
  writeFileSync(join(directory, 'recipe.json'), JSON.stringify({ database, version, displayVersion: version, name: database, image: 'test:1', platforms: ['linux/amd64'], service: 'database', defaultPort: 1234, connection: { host: '127.0.0.1', port: 1235, password: '123456', database: database === 'redis' ? 0 : 'dbx' }, smoke: { steps: [{ name: 'smoke', command: ['true'], expect: 'true' }] }, shell: ['true'] }));
  writeFileSync(join(directory, 'compose.yaml'), `services:\n  database:\n    image: test:1\n    platform: linux/amd64\n    container_name: dbx-${database}-${version}\n    ports:\n      - "\${DB_BIND_ADDRESS:-127.0.0.1}:\${DB_PORT:-1235}:1234"\n    volumes:\n      - data:/var/lib/database\n    healthcheck:\n      test: ["CMD", "true"]\nvolumes:\n  data:\n`);
  return root;
}

test('discovers versioned recipes', () => {
  const recipes = discoverRecipes(fixture('mysql', '5.7'));
  assert.equal(recipes.length, 1);
  assert.equal(recipes[0].database, 'mysql');
});

test('requires DB and rejects ambiguous versions', () => {
  assert.throws(() => resolveRecipe([], ''), /DB is required/);
  const recipes = [{ database: 'mysql', displayVersion: '5.7' }, { database: 'mysql', displayVersion: '8.4' }];
  assert.throws(() => resolveRecipe(recipes, 'mysql'), /multiple versions/);
  assert.equal(resolveRecipe(recipes, 'mysql', '8.4').displayVersion, '8.4');
});

test('accepts the compact product@version database selector', () => {
  assert.deepEqual(parseDatabaseSelection('mysql@8.4'), { database: 'mysql', version: '8.4' });
  assert.deepEqual(parseDatabaseSelection('mysql@8.4', '8.4'), { database: 'mysql', version: '8.4' });
  assert.throws(() => parseDatabaseSelection('mysql@8.4', '5.7'), /conflicts/);
  assert.throws(() => parseDatabaseSelection('mysql@'), /format/);
});

test('formats a recipe as a copyable compact selector', () => {
  assert.equal(recipeSelector({ database: 'mysql', displayVersion: '8.4' }), 'mysql@8.4');
});

test('formats lists as left-aligned tables with dynamic column widths', () => {
  assert.equal(
    formatTable(
      ['DATABASE', 'VERSION', 'IMAGE'],
      [
        ['etcd', '3.7', 'etcd:v3.7.0'],
        ['clickhouse', '24.8', 'clickhouse-server:24.8.14.39'],
      ],
    ),
    'DATABASE    VERSION  IMAGE\n'
      + 'etcd        3.7      etcd:v3.7.0\n'
      + 'clickhouse  24.8     clickhouse-server:24.8.14.39',
  );
});

test('discovers all public Make targets for shell completion', () => {
  const targets = discoverMakeTargets();
  for (const target of ['help', 'build', 'test', 'docs', 'db', 'db-verify', 'db-completion']) {
    assert.ok(targets.includes(target), `missing Make target: ${target}`);
  }
  assert.equal(new Set(targets).size, targets.length);
});

test('Bash completion preserves all Make targets and completes database selectors', { skip: !bashAvailable }, () => {
  const repoRoot = join(DEFAULT_RECIPES_ROOT, '..', '..');
  const completionScript = join(DEFAULT_RECIPES_ROOT, 'completion', 'dbx-make.bash');
  const result = spawnSync(
    'bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      'source "$COMPLETION_SCRIPT"; COMP_WORDS=(make ""); COMP_CWORD=1; _dbx_make; printf "TARGET:%s\\n" "${COMPREPLY[@]}"; COMP_WORDS=(make db DB=); COMP_CWORD=2; _dbx_make; printf "SELECTOR:%s\\n" "${COMPREPLY[@]}"',
    ],
    { cwd: repoRoot, env: { ...process.env, COMPLETION_SCRIPT: completionScript }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^TARGET:build$/m);
  assert.match(result.stdout, /^TARGET:test$/m);
  assert.match(result.stdout, /^TARGET:db$/m);
  assert.match(result.stdout, /^SELECTOR:DB=mysql@8\.4$/m);
});

test('Bash completion delegates to the previous completer outside the repository', { skip: !bashAvailable }, () => {
  const completionScript = join(DEFAULT_RECIPES_ROOT, 'completion', 'dbx-make.bash');
  const result = spawnSync(
    'bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      '_original_make_completion() { COMPREPLY=(ORIGINAL); }; complete -F _original_make_completion make; source "$COMPLETION_SCRIPT"; cd "$TMPDIR"; COMP_WORDS=(make db DB=); COMP_CWORD=2; _dbx_make; printf "%s\\n" "${COMPREPLY[@]}"',
    ],
    { env: { ...process.env, COMPLETION_SCRIPT: completionScript, TMPDIR: tmpdir() }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'ORIGINAL');
});

test('Zsh completion delegates ordinary Make completion and handles DB selectors', { skip: !zshAvailable }, () => {
  const repoRoot = join(DEFAULT_RECIPES_ROOT, '..', '..');
  const completionScript = join(DEFAULT_RECIPES_ROOT, 'completion', '_dbx-make.zsh');
  const result = spawnSync(
    'zsh',
    [
      '-f',
      '-c',
      'autoload -Uz compinit && compinit -D; _original_make_completion() { print ORIGINAL; }; compdef _original_make_completion make; source "$COMPLETION_SCRIPT"; words=(make ""); CURRENT=2; _dbx_make; _describe() { local values_name="$2"; print -l -- "${(@P)values_name}"; }; compset() { return 0; }; words=(make db DB=); CURRENT=3; _dbx_make',
    ],
    { cwd: repoRoot, env: { ...process.env, COMPLETION_SCRIPT: completionScript }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ORIGINAL$/m);
  assert.match(result.stdout, /^mysql@8\.4$/m);
});

test('records the MySQL 5.7 CNB mirror as a multi-architecture image', () => {
  const recipe = discoverRecipes().find((item) => recipeSelector(item) === 'mysql@5.7');
  assert.ok(recipe);
  assert.deepEqual(recipe.platforms, ['linux/amd64', 'linux/arm64']);
  assert.equal(recipe.notes, undefined);
});

test('warns only when the current architecture is unsupported', () => {
  const recipe = { image: 'mirror/redis:3', platforms: ['linux/amd64'] };
  assert.equal(platformForArchitecture('arm64'), 'linux/arm64');
  assert.equal(architectureWarning(recipe, 'x64'), null);
  assert.match(architectureWarning(recipe, 'arm64'), /does not support linux\/arm64/);
});

test('uses the approved CNB mirror images and matching recipe versions', () => {
  const recipes = Object.fromEntries(
    discoverRecipes().map((recipe) => [recipeSelector(recipe), { version: recipe.version, image: recipe.image, platforms: recipe.platforms }]),
  );
  assert.deepEqual(recipes, {
    'clickhouse@24.8': { version: '24.8.14.39', image: 'docker.cnb.cool/znb/images/clickhouse-server:24.8.14.39', platforms: ['linux/amd64', 'linux/arm64'] },
    'etcd@3.7': { version: '3.7.0', image: 'docker.cnb.cool/znb/images/etcd:v3.7.0', platforms: ['linux/amd64', 'linux/arm64'] },
    'kafka@4.3': { version: '4.3.1', image: 'docker.cnb.cool/znb/images/kafka:4.3.1', platforms: ['linux/amd64', 'linux/arm64'] },
    'mariadb@10.11': { version: '10.11.11', image: 'docker.cnb.cool/znb/images/mariadb:10.11.11', platforms: ['linux/amd64', 'linux/arm64'] },
    'mongodb@5.0': { version: '5.0.5', image: 'docker.cnb.cool/znb/images/mongo:5.0.5', platforms: ['linux/amd64', 'linux/arm64'] },
    'mongodb@8.2': { version: '8.2.3', image: 'docker.cnb.cool/znb/images/mongo:8.2.3-noble', platforms: ['linux/amd64', 'linux/arm64'] },
    'mysql@5.7': { version: '5.7.44', image: 'docker.cnb.cool/znb/images/mysql:5.7.44', platforms: ['linux/amd64', 'linux/arm64'] },
    'mysql@8.4': { version: '8.4.6', image: 'docker.cnb.cool/znb/images/mysql:8.4.6', platforms: ['linux/amd64', 'linux/arm64'] },
    'nacos@2.5': { version: '2.5.2', image: 'docker.cnb.cool/znb/images/nacos-server:v2.5.2', platforms: ['linux/amd64', 'linux/arm64'] },
    'nacos@3.2': { version: '3.2.2', image: 'docker.cnb.cool/znb/images/nacos-server:v3.2.2', platforms: ['linux/amd64', 'linux/arm64'] },
    'postgresql@14.23': { version: '14.23', image: 'docker.cnb.cool/znb/images/postgres:14.23', platforms: ['linux/amd64', 'linux/arm64'] },
    'postgresql@17.4': { version: '17.4', image: 'docker.cnb.cool/znb/images/postgres:17.4', platforms: ['linux/amd64', 'linux/arm64'] },
    'pulsar@4.2': { version: '4.2.3', image: 'docker.cnb.cool/znb/images/pulsar:4.2.3', platforms: ['linux/amd64', 'linux/arm64'] },
    'qdrant@1.8': { version: '1.8.3', image: 'docker.cnb.cool/znb/images/qdrant:v1.8.3', platforms: ['linux/amd64', 'linux/arm64'] },
    'redis@3.0.7': { version: '3.0.7', image: 'docker.cnb.cool/znb/images/redis:3.0.7-alpine', platforms: ['linux/amd64'] },
    'redis@7.4': { version: '7.4.9', image: 'docker.cnb.cool/znb/images/redis:7.4.9-alpine', platforms: ['linux/amd64', 'linux/arm64'] },
    'rnacos@0.8': { version: '0.8.5', image: 'docker.cnb.cool/znb/images/rnacos:v0.8.5', platforms: ['linux/amd64', 'linux/arm64'] },
    'zookeeper@3.9': { version: '3.9.5', image: 'docker.cnb.cool/znb/images/zookeeper:3.9.5', platforms: ['linux/amd64', 'linux/arm64'] },
  });
  assert.equal(discoverRecipes().find((recipe) => recipeSelector(recipe) === 'redis@3.0.7').connection.username, undefined);
});

test('initializes both Nacos versions with the shared administrator credentials', () => {
  for (const recipe of discoverRecipes().filter((item) => item.database === 'nacos')) {
    assert.equal(recipe.connection.username, 'nacos');
    assert.equal(recipe.connection.password, '123456');
    assert.equal(recipe.connection.namespace, 'public');
    assert.equal(recipe.bootstrap.check.expect, 'accessToken');
    assert.equal(recipe.bootstrap.steps.length, 1);
    assert.match(recipe.bootstrap.steps[0].command.join(' '), /administrator initialized/);

    const compose = readFileSync(join(recipe.directory, 'compose.yaml'), 'utf8');
    assert.doesNotMatch(compose, /^  initialize:/m);
    assert.doesNotMatch(compose, /tail -f \/dev\/null/);
    assert.deepEqual(validateRecipe(recipe), []);
  }
});

test('configures r-nacos with its admin account and console port', () => {
  const recipe = discoverRecipes().find((item) => recipeSelector(item) === 'rnacos@0.8');
  assert.equal(recipe.connection.username, 'admin');
  assert.equal(recipe.connection.password, '123456');
  assert.equal(recipe.connection.grpcPort, 9849);
  assert.equal(recipe.connection.consolePort, 10849);

  const compose = readFileSync(join(recipe.directory, 'compose.yaml'), 'utf8');
  assert.match(compose, /RNACOS_CONSOLE_PORT/);
  assert.doesNotMatch(compose, /curl/);
  assert.deepEqual(validateRecipe(recipe), []);
});

test('configures Qdrant with the shared API key', () => {
  const recipe = discoverRecipes().find((item) => recipeSelector(item) === 'qdrant@1.8');
  assert.equal(recipe.connection.username, '');
  assert.equal(recipe.connection.password, '123456');
  assert.equal(recipe.connection.apiKey, undefined);
});

test('bootstraps etcd with the shared root credentials', () => {
  const recipe = discoverRecipes().find((item) => recipeSelector(item) === 'etcd@3.7');
  assert.equal(recipe.connection.username, 'root');
  assert.equal(recipe.connection.password, '123456');
  assert.ok(recipe.bootstrap);
});

test('bootstraps ZooKeeper with the shared Digest credentials', () => {
  const recipe = discoverRecipes().find((item) => recipeSelector(item) === 'zookeeper@3.9');
  assert.equal(recipe.connection.username, 'root');
  assert.equal(recipe.connection.password, '123456');
  assert.equal(recipe.connection.authScheme, 'digest');
});

test('keeps existing authenticated bootstrap recipes valid', () => {
  for (const selector of ['etcd@3.7', 'zookeeper@3.9']) {
    const recipe = discoverRecipes().find((item) => recipeSelector(item) === selector);
    assert.deepEqual(validateRecipe(recipe), []);
  }
});

test('marks the unauthenticated Kafka and Pulsar development recipes explicitly', () => {
  for (const selector of ['kafka@4.3', 'pulsar@4.2']) {
    const recipe = discoverRecipes().find((item) => recipeSelector(item) === selector);
    assert.equal(recipe.connection.authentication, 'none');
    assert.equal(recipe.connection.password, undefined);
  }
});

test('start without DB prints every copyable database command', () => {
  const repoRoot = join(DEFAULT_RECIPES_ROOT, '..', '..');
  const result = spawnSync(process.execPath, ['scripts/database-env.mjs', 'start'], {
    cwd: repoRoot,
    env: { ...process.env, DB: '', DB_VERSION: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  for (const recipe of discoverRecipes()) {
    assert.ok(result.stdout.includes(`make db DB=${recipeSelector(recipe)}`));
  }
});

test('reset requires explicit confirmation', () => {
  assert.throws(() => assertResetConfirmed(''), /CONFIRM=1/);
  assert.doesNotThrow(() => assertResetConfirmed('1'));
});

test('static validation accepts a minimal safe recipe', () => {
  const [recipe] = discoverRecipes(fixture('redis', '7.4'));
  assert.deepEqual(validateRecipe(recipe), []);
});

test('smoke commands use password and port overrides without invoking a shell', () => {
  const recipe = { connection: { password: 'default-password', port: 3306 } };
  assert.deepEqual(
    expandSmokeCommand(['client', '--password=${DB_PASSWORD}', '--port=${DB_PORT}'], recipe, { DB_PASSWORD: 'override', DB_PORT: '13306' }),
    ['client', '--password=override', '--port=13306'],
  );
});

test('MongoDB commands pass reserved-character passwords as a distinct argument', () => {
  const password = 'p@ss/word#with?reserved&characters';
  for (const recipe of discoverRecipes().filter((item) => item.database === 'mongodb')) {
    for (const command of [recipe.shell, ...recipe.smoke.steps.map((step) => step.command)]) {
      const expanded = expandSmokeCommand(command, recipe, { DB_PASSWORD: password });
      const passwordIndex = expanded.indexOf('--password');
      assert.notEqual(passwordIndex, -1);
      assert.equal(expanded[passwordIndex + 1], password);
      assert.equal(expanded.some((argument) => argument.includes('mongodb://')), false);
    }
  }
});

test('requires every port mapping to default to loopback with an explicit override', () => {
  assert.equal(allPortMappingsDefaultToLoopback('services:\n  database:\n    ports:\n      - "127.0.0.1:3306:3306"'), false);
  assert.equal(allPortMappingsDefaultToLoopback('services:\n  database:\n    ports:\n      - "${DB_BIND_ADDRESS:-127.0.0.1}:3306:3306"'), true);
  assert.equal(allPortMappingsDefaultToLoopback('services:\n  database:\n    ports:\n      - "${DB_BIND_ADDRESS:-0.0.0.0}:3306:3306"'), false);
});

test('rendered Compose recipes bind to loopback by default', { skip: !dockerComposeAvailable }, () => {
  const recipes = discoverRecipes();
  for (const recipe of recipes) {
    const result = spawnSync('docker', ['compose', '--file', join(recipe.directory, 'compose.yaml'), 'config', '--format', 'json'], {
      encoding: 'utf8',
      env: { ...process.env, DB_BIND_ADDRESS: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotThrow(() => validateRenderedCompose(recipe, JSON.parse(result.stdout)));
  }

  const remoteResult = spawnSync('docker', ['compose', '--file', join(recipes[0].directory, 'compose.yaml'), 'config', '--format', 'json'], {
    encoding: 'utf8',
    env: { ...process.env, DB_BIND_ADDRESS: '0.0.0.0' },
  });
  assert.equal(remoteResult.status, 0, remoteResult.stderr);
  const remoteService = JSON.parse(remoteResult.stdout).services[recipes[0].service];
  assert.ok(remoteService.ports.every((port) => port.host_ip === '0.0.0.0'));
});

test('healthchecks safely reference configurable passwords', { skip: !dockerComposeAvailable }, () => {
  const password = "space ' password";
  const recipes = discoverRecipes().filter((recipe) => ['mariadb', 'mongodb', 'mysql', 'redis'].includes(recipe.database));

  for (const recipe of recipes) {
    const result = spawnSync('docker', ['compose', '--file', join(recipe.directory, 'compose.yaml'), 'config', '--format', 'json'], {
      encoding: 'utf8',
      env: { ...process.env, DB_PASSWORD: password },
    });
    assert.equal(result.status, 0, result.stderr);

    const service = JSON.parse(result.stdout).services[recipe.service];
    const command = service.healthcheck.test[1];
    assert.equal(command.includes(password), false, `${recipeSelector(recipe)} interpolates the password into CMD-SHELL`);

    if (recipe.database === 'mongodb') assert.match(command, /--password "\$\$MONGO_INITDB_ROOT_PASSWORD"/);
    if (recipe.database === 'mysql') assert.match(command, /-p"\$\$MYSQL_ROOT_PASSWORD"/);
    if (recipe.database === 'mariadb') assert.match(command, /-p"\$\$MARIADB_ROOT_PASSWORD"/);
    if (recipe.database === 'redis') {
      assert.equal(service.environment.REDIS_PASSWORD, password);
      assert.match(command, /-a "\$\$REDIS_PASSWORD"/);
    }
  }
});

test('requires the target service to mount a named volume', () => {
  const bindOnly = 'services:\n  database:\n    volumes:\n      - ./init:/docker-entrypoint-initdb.d:ro\nvolumes:\n  data:\n';
  const namedVolume = 'services:\n  database:\n    volumes:\n      - data:/var/lib/database\nvolumes:\n  data:\n';
  assert.equal(serviceHasNamedVolume(bindOnly, 'database'), false);
  assert.equal(serviceHasNamedVolume(namedVolume, 'database'), true);
});

test('derives the required dbx-prefixed container name', () => {
  assert.equal(expectedContainerName({ database: 'mysql', displayVersion: '5.7' }), 'dbx-mysql-5.7');
  assert.equal(expectedContainerName({ database: 'PostgreSQL', displayVersion: '17.4' }), 'dbx-postgresql-17.4');
});

test('rejects a recipe whose Compose container name is not standardized', () => {
  const [recipe] = discoverRecipes(fixture('mysql', '8.4'));
  const composePath = join(recipe.directory, 'compose.yaml');
  writeFileSync(composePath, readFileSync(composePath, 'utf8').replace('container_name: dbx-mysql-8.4', 'container_name: custom-mysql'));
  assert.match(validateRecipe(recipe).join('; '), /container_name must be dbx-mysql-8.4/);
});

test('requires the shared default password and database name', () => {
  const [recipe] = discoverRecipes(fixture('postgresql', '17.4'));
  recipe.connection.password = 'different';
  recipe.connection.database = 'other';
  assert.match(validateRecipe(recipe).join('; '), /connection.password must be 123456/);
  assert.match(validateRecipe(recipe).join('; '), /connection.database must be dbx/);
});

test('allows recipes that explicitly declare no authentication', () => {
  const [recipe] = discoverRecipes(fixture('postgresql', '17.4'));
  recipe.connection.authentication = 'none';
  delete recipe.connection.password;
  assert.deepEqual(validateRecipe(recipe), []);
});

test('requires every recipe port to be one greater than its database default port', () => {
  const [recipe] = discoverRecipes(fixture('postgresql', '17.4'));
  recipe.connection.port = 5432;
  assert.match(validateRecipe(recipe).join('; '), /connection.port must be defaultPort \+ 1/);
});

test('reports missing smoke structures without throwing a TypeError', () => {
  const [recipe] = discoverRecipes(fixture('postgresql', '17.4'));
  delete recipe.smoke;
  let errors;
  assert.doesNotThrow(() => {
    errors = validateRecipe(recipe);
  });
  assert.match(errors.join('; '), /missing smoke/);
  assert.match(errors.join('; '), /smoke\.steps must not be empty/);

  recipe.smoke = {};
  assert.doesNotThrow(() => validateRecipe(recipe));
  assert.match(validateRecipe(recipe).join('; '), /smoke\.steps must not be empty/);
});

test('documents every checked-in recipe on both website pages', () => {
  const pages = [
    join(DEFAULT_RECIPES_ROOT, '..', '..', 'docs', 'content', 'docs', 'database-lab.mdx'),
    join(DEFAULT_RECIPES_ROOT, '..', '..', 'docs', 'content', 'docs', 'database-lab.cn.mdx'),
  ].map((path) => readFileSync(path, 'utf8'));

  for (const recipe of discoverRecipes()) {
    const entry = `\`${recipe.database}/${recipe.displayVersion}\``;
    for (const page of pages) assert.ok(page.includes(entry), `missing ${entry} from database lab documentation`);
  }
});
