#!/usr/bin/env node
// Lifecycle CLI for the disposable, PER-VERSION Odoo integration harness.
// Zero deps — plain node. Every command takes an Odoo version (16.0|17.0|18.0|19.0)
// and drives one parameterized compose stack (see harness/compose.yaml). Distinct
// versions use distinct compose projects / images / volumes / host ports, so two
// can run CONCURRENTLY without collisions.
//
//   node harness/cli.mjs up <version>      build + start + init db (if absent) + seed (if no state)
//   node harness/cli.mjs down <version>    stop the stack (keep volumes + state)
//   node harness/cli.mjs reset <version>   stop and WIPE volumes + state (truly disposable)
//   node harness/cli.mjs logs <version>    follow logs
//   node harness/cli.mjs status            show every version: running? seeded?
//
// `up` is idempotent: on an already-running, already-seeded stack it is a no-op that
// just prints the state file path.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE = join(HERE, "compose.yaml");
const STATE_ROOT = join(HERE, ".state");
const SEED = join(HERE, "seed.py");

const SUPPORTED = ["16.0", "17.0", "18.0", "19.0"];

function assertVersion(v) {
  if (!SUPPORTED.includes(v)) {
    fail(`unsupported version "${v}". Supported: ${SUPPORTED.join(", ")}`);
  }
}

/** Everything a version needs, derived from the version string alone. */
function ctx(version) {
  const major = version.split(".")[0]; // "16"
  const port = String(8000 + Number(major)); // 8016
  const db = `odoo_rpc_ts_${major}`;
  const stateDir = join(STATE_ROOT, version);
  const stateFile = join(stateDir, "env");
  const env = {
    ...process.env,
    ODOO_HARNESS_VERSION: version,
    ODOO_HARNESS_MAJOR: major,
    ODOO_HARNESS_BASE_IMAGE: `odoo:${version}`,
    ODOO_HARNESS_PORT: port,
    ODOO_HARNESS_DB: db,
    // db creds: defaults are fine for a disposable local harness.
    ODOO_HARNESS_DB_USER: process.env.ODOO_HARNESS_DB_USER ?? "odoo",
    ODOO_HARNESS_DB_PASSWORD: process.env.ODOO_HARNESS_DB_PASSWORD ?? "odoo",
  };
  return { version, major, port, db, stateDir, stateFile, env };
}

function fail(msg) {
  console.error(`harness: ${msg}`);
  process.exit(1);
}

/** docker compose with the harness file + version env; inherits stdio. */
function dc(c, args, opts = {}) {
  return execFileSync("docker", ["compose", "-f", COMPOSE, ...args], {
    cwd: HERE,
    env: c.env,
    stdio: "inherit",
    ...opts,
  });
}

/** Same, but capture stdout (trimmed). Returns "" on failure when soft. */
function dcCapture(c, args, { soft = false } = {}) {
  try {
    return execFileSync("docker", ["compose", "-f", COMPOSE, ...args], {
      cwd: HERE,
      env: c.env,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch (e) {
    if (soft) return "";
    throw e;
  }
}

function odooRunning(c) {
  const ids = dcCapture(c, ["ps", "-q", "--status", "running", "odoo"], { soft: true });
  return ids.length > 0;
}

function dbInitialised(c) {
  // The db container must be up for this probe; callers ensure that first.
  const out = dcCapture(
    c,
    [
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      c.env.ODOO_HARNESS_DB_USER,
      "-d",
      "postgres",
      "-tAc",
      `SELECT 1 FROM pg_database WHERE datname='${c.db}'`,
    ],
    { soft: true },
  );
  return out === "1";
}

function requireDocker() {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    fail("docker daemon is not reachable — start Docker and retry.");
  }
}

// --- commands ----------------------------------------------------------------

function up(version) {
  assertVersion(version);
  requireDocker();
  const c = ctx(version);

  if (existsSync(c.stateFile) && odooRunning(c)) {
    console.log(`harness: ${version} already up and seeded.`);
    console.log(`  state: ${c.stateFile}`);
    console.log(`  url:   http://localhost:${c.port}`);
    return;
  }

  console.log(`harness: building/starting db for ${version} (project odoo-rpc-ts-${c.major})…`);
  // Bring up db first so we can probe/init before serving.
  dc(c, ["up", "-d", "--build", "db"]);

  if (!dbInitialised(c)) {
    console.log(`harness: initialising db "${c.db}" (base,web, no demo)…`);
    dc(c, [
      "run",
      "--rm",
      "-T",
      "odoo",
      "odoo",
      "-c",
      "/etc/odoo/odoo.conf",
      "-d",
      c.db,
      "-i",
      "base,web",
      "--stop-after-init",
      "--without-demo=all",
    ]);
  } else {
    console.log(`harness: db "${c.db}" already initialised — skipping init.`);
  }

  if (!existsSync(c.stateFile)) {
    console.log(`harness: seeding rpc user + API key…`);
    mkdirSync(c.stateDir, { recursive: true });
    // Mount the whole .state dir; seed writes <version>/env under it.
    dc(
      c,
      [
        "run",
        "--rm",
        "-T",
        "-v",
        `${STATE_ROOT}:/harness-state`,
        "-e",
        `ODOO_HARNESS_DB=${c.db}`,
        "-e",
        `ODOO_HARNESS_PORT=${c.port}`,
        "-e",
        `ODOO_HARNESS_VERSION=${version}`,
        "odoo",
        "odoo",
        "shell",
        "-c",
        "/etc/odoo/odoo.conf",
        "-d",
        c.db,
        "--no-http",
      ],
      // Pipe the seed script to `odoo shell` stdin; keep out/err on the console.
      { input: readSeed(), stdio: ["pipe", "inherit", "inherit"] },
    );
    if (!existsSync(c.stateFile)) {
      fail(`seed ran but no state file at ${c.stateFile} — check logs.`);
    }
    // GOTCHA: seeding runs in a separate container. If the server was already
    // up (re-seed path), its ormcache (e.g. ir.model.access.check) can hold
    // stale group data indefinitely — restart to flush.
    dc(c, ["restart", "odoo"]);
  } else {
    console.log(`harness: state file present — skipping seed.`);
  }

  console.log(`harness: starting odoo server…`);
  dc(c, ["up", "-d", "odoo"]);

  console.log(`\nharness: ${version} up.`);
  console.log(`  state: ${c.stateFile}`);
  console.log(`  url:   http://localhost:${c.port}`);
}

function readSeed() {
  return execFileSync("cat", [SEED]);
}

function down(version) {
  assertVersion(version);
  requireDocker();
  const c = ctx(version);
  dc(c, ["down", "--remove-orphans"]);
  console.log(`harness: ${version} stopped (volumes + state kept).`);
}

function reset(version) {
  assertVersion(version);
  requireDocker();
  const c = ctx(version);
  dc(c, ["down", "-v", "--remove-orphans"]);
  rmSync(c.stateDir, { recursive: true, force: true });
  console.log(`harness: ${version} wiped (volumes + state removed).`);
}

function logs(version) {
  assertVersion(version);
  requireDocker();
  const c = ctx(version);
  dc(c, ["logs", "-f"]);
}

function status() {
  requireDocker();
  console.log("version  running  seeded  url");
  for (const version of SUPPORTED) {
    const c = ctx(version);
    const running = odooRunning(c) ? "yes" : "no ";
    const seeded = existsSync(c.stateFile) ? "yes" : "no ";
    console.log(`${version.padEnd(8)} ${running.padEnd(8)} ${seeded.padEnd(7)} http://localhost:${c.port}`);
  }
}

// --- dispatch ----------------------------------------------------------------

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "up":
    up(arg);
    break;
  case "down":
    down(arg);
    break;
  case "reset":
    reset(arg);
    break;
  case "logs":
    logs(arg);
    break;
  case "status":
    status();
    break;
  default:
    console.log(
      `Usage: node harness/cli.mjs <up|down|reset|logs> <version> | status\n` +
        `Versions: ${SUPPORTED.join(", ")}`,
    );
    process.exit(cmd ? 1 : 0);
}
