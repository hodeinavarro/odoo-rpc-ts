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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE = join(HERE, "compose.yaml");
const STATE_ROOT = join(HERE, ".state");
const SEED = join(HERE, "seed.py");
const STATE_MARKER = "ODOO_RPC_TS_HARNESS_STATE_V1:";

const SUPPORTED = ["16.0", "17.0", "18.0", "19.0"];
const APPLICATIONS = ["account", "crm", "project", "purchase", "sale_management", "stock"];
const PROFILE = "applications-demo-v2";

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
    // Master password gating db-management ops; templated into odoo.conf and
    // recorded in the state file so the db integration suite can use it.
    ODOO_HARNESS_MASTER_PASSWORD: process.env.ODOO_HARNESS_MASTER_PASSWORD ?? "master",
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

function applicationProfileReady(c) {
  const names = APPLICATIONS.map((name) => `'${name}'`).join(",");
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
      c.db,
      "-tAc",
      `SELECT count(*) FROM ir_module_module WHERE name IN (${names}) AND state='installed' AND demo IS TRUE`,
    ],
    { soft: true },
  );
  return out === String(APPLICATIONS.length);
}

function stateReady(c) {
  return withStatePermissionDiagnostic(c, () => {
    secureStatePermissions(c);
    return (
      existsSync(c.stateFile) &&
      readFileSync(c.stateFile, "utf8").includes(`ODOO_HARNESS_PROFILE=${PROFILE}\n`)
    );
  });
}

function withStatePermissionDiagnostic(c, operation) {
  try {
    return operation();
  } catch (error) {
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      fail(
        `legacy harness state at "${c.stateDir}" is not accessible to this host user. ` +
          "It may have been created by the old container-owned layout. With sufficient " +
          "privileges, remove this disposable directory or repair its ownership, then retry.",
      );
    }
    throw error;
  }
}

function removeState(c) {
  withStatePermissionDiagnostic(c, () => {
    rmSync(c.stateDir, { recursive: true, force: true });
  });
}

/** State contains generated credentials: directories are owner-only, files 0600. */
function secureStatePermissions(c) {
  for (const [path, mode] of [
    [STATE_ROOT, 0o700],
    [c.stateDir, 0o700],
    [c.stateFile, 0o600],
  ]) {
    if (existsSync(path) && (statSync(path).mode & 0o7777) !== mode) {
      chmodSync(path, mode);
    }
  }
}

function decodeSeedState(output, c) {
  const markers = output.split(/\r?\n/).filter((line) => line.startsWith(STATE_MARKER));
  if (markers.length !== 1) {
    throw new Error("seed output did not contain exactly one state marker");
  }

  const encoded = markers[0].slice(STATE_MARKER.length);
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error("seed state marker was not canonical base64");
  }

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error("seed state marker was not canonical base64");
  }
  const state = bytes.toString("utf8");
  if (!Buffer.from(state, "utf8").equals(bytes)) {
    throw new Error("seed state marker was not UTF-8");
  }

  const expectedKeys = [
    "ODOO_URL",
    "ODOO_DB",
    "ODOO_USERNAME",
    "ODOO_PASSWORD",
    "ODOO_API_KEY",
    "ODOO_RESTRICTED_USERNAME",
    "ODOO_RESTRICTED_PASSWORD",
    "ODOO_RESTRICTED_API_KEY",
    "ODOO_MASTER_PASSWORD",
    "ODOO_HARNESS_VERSION",
    "ODOO_HARNESS_PROFILE",
  ];
  const lines = state.split("\n");
  if (lines.length !== expectedKeys.length + 1 || lines.at(-1) !== "") {
    throw new Error("seed state payload had an unexpected shape");
  }

  const values = new Map();
  for (const [index, key] of expectedKeys.entries()) {
    const prefix = `${key}=`;
    const line = lines[index];
    if (!line.startsWith(prefix)) {
      throw new Error("seed state payload had an unexpected shape");
    }
    values.set(key, line.slice(prefix.length));
  }

  const expectedValues = new Map([
    ["ODOO_URL", `http://localhost:${c.port}`],
    ["ODOO_DB", c.db],
    ["ODOO_USERNAME", "rpc"],
    ["ODOO_PASSWORD", "rpc-integration"],
    ["ODOO_RESTRICTED_USERNAME", "rpc-restricted"],
    ["ODOO_RESTRICTED_PASSWORD", "rpc-restricted-integration"],
    ["ODOO_MASTER_PASSWORD", c.env.ODOO_HARNESS_MASTER_PASSWORD],
    ["ODOO_HARNESS_VERSION", c.version],
    ["ODOO_HARNESS_PROFILE", PROFILE],
  ]);
  for (const [key, value] of expectedValues) {
    if (values.get(key) !== value) {
      throw new Error("seed state payload did not match the requested harness");
    }
  }
  if (!values.get("ODOO_API_KEY") || !values.get("ODOO_RESTRICTED_API_KEY")) {
    throw new Error("seed state payload omitted generated credentials");
  }

  return state;
}

function writeState(c, state) {
  withStatePermissionDiagnostic(c, () => {
    mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
    secureStatePermissions(c);
    mkdirSync(c.stateDir, { mode: 0o700 });
    secureStatePermissions(c);
    writeFileSync(c.stateFile, state, { encoding: "utf8", flag: "wx", mode: 0o600 });
    secureStatePermissions(c);
  });
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

  console.log(`harness: building/starting db for ${version} (project odoo-rpc-ts-${c.major})…`);
  // Bring up db first so we can probe/init before serving.
  dc(c, ["up", "-d", "--build", "db"]);

  if (!dbInitialised(c)) {
    console.log(
      `harness: initialising db "${c.db}" with application demos (${APPLICATIONS.join(",")})…`,
    );
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
      APPLICATIONS.join(","),
      "--stop-after-init",
    ]);
  } else if (!applicationProfileReady(c)) {
    fail(
      `db "${c.db}" is not the application-demo profile. Run ` +
        `"pnpm harness reset ${version}" once, then retry; existing volumes are never migrated implicitly.`,
    );
  } else if (stateReady(c) && odooRunning(c)) {
    console.log(`harness: ${version} already up, application demos verified, and seeded.`);
    console.log(`  state: ${c.stateFile}`);
    console.log(`  url:   http://localhost:${c.port}`);
    return;
  } else {
    console.log(`harness: db "${c.db}" application-demo profile verified — skipping init.`);
  }

  if (!applicationProfileReady(c)) {
    fail(`db "${c.db}" initialised but the application-demo profile could not be verified.`);
  }

  if (!stateReady(c)) {
    console.log(`harness: seeding rpc user + API key…`);
    // Remove incomplete host state before generating a fresh handoff. The
    // container never mounts .state; the host CLI creates the final file.
    removeState(c);
    let seedOutput;
    try {
      seedOutput = dc(
        c,
        [
          "run",
          "--rm",
          "-T",
          "-e",
          `ODOO_HARNESS_DB=${c.db}`,
          "-e",
          `ODOO_HARNESS_PORT=${c.port}`,
          "-e",
          `ODOO_HARNESS_VERSION=${version}`,
          "-e",
          `ODOO_HARNESS_MASTER_PASSWORD=${c.env.ODOO_HARNESS_MASTER_PASSWORD}`,
          "odoo",
          "odoo",
          "shell",
          "-c",
          "/etc/odoo/odoo.conf",
          "-d",
          c.db,
          "--no-http",
        ],
        // Stdout is reserved for the opaque state marker. Progress and Odoo
        // diagnostics remain visible on stderr.
        {
          encoding: "utf8",
          input: readSeed(),
          maxBuffer: 4 * 1024 * 1024,
          stdio: ["pipe", "pipe", "inherit"],
        },
      );
    } catch {
      fail("seed command failed — see the container diagnostics above.");
    }

    let state;
    try {
      state = decodeSeedState(seedOutput, c);
    } catch {
      fail("seed completed without a valid state handoff; no credentials were written.");
    }
    try {
      writeState(c, state);
    } catch {
      fail(`could not create secure host state at ${c.stateFile}; remove it and retry.`);
    }
    console.log(`harness-seed: wrote state file ${c.stateFile}`);
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
  removeState(c);
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
    const seeded = stateReady(c) ? "yes" : "no ";
    console.log(
      `${version.padEnd(8)} ${running.padEnd(8)} ${seeded.padEnd(7)} http://localhost:${c.port}`,
    );
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
