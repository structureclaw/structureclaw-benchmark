const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BENCH_ROOT = path.resolve(__dirname, "..");
const RUNNER_PATH = path.join(BENCH_ROOT, "runner.cjs");
const LOCAL_CONFIG_PATH = path.join(BENCH_ROOT, "experiments", "llm-experiments.local.json");
const EXAMPLE_CONFIG_PATH = path.join(BENCH_ROOT, "experiments", "llm-experiments.example.json");
const RUNTIME_ROOT = path.join(BENCH_ROOT, "runtime");

const DEFAULT_DEFAULTS = {
  suite: "smoke-text",
  mode: "auto",
  supervise: true,
  outputDir: "results",
};

const DEFAULT_SUITES = {
  "smoke-text": {
    description: "One text-only scenario for checking the experiment stack.",
    modelRole: "test",
    runnerArgs: ["--scenario", "std-beam-4m-point-mid"],
  },
  "smoke-multimodal": {
    description: "One image scenario for checking the multimodal model path.",
    modelRole: "multimodal",
    runnerArgs: ["--scenario", "image-beam-sketch"],
  },
  standard: {
    description: "All standard executable workflow scenarios.",
    modelRole: "test",
    runnerArgs: ["--family", "standard_workflow"],
  },
  interactive: {
    description: "All interactive and robustness workflow scenarios.",
    modelRole: "test",
    runnerArgs: ["--family", "interactive_robustness"],
  },
  core: {
    description: "All non-multimodal core scenarios.",
    modelRole: "test",
    runnerArgs: ["--split", "core"],
  },
  multimodal: {
    description: "All multimodal reverse-engineering scenarios.",
    modelRole: "multimodal",
    runnerArgs: ["--family", "multimodal_reverse_engineering"],
  },
  "all-auto": {
    description: "All scenarios in auto routing mode. Uses the multimodal role because the corpus includes image tasks.",
    modelRole: "multimodal",
    runnerArgs: [],
  },
  "all-modes": {
    description: "All scenarios expanded across benchmark skill modes. Uses the multimodal role because the corpus includes image tasks.",
    modelRole: "multimodal",
    runnerArgs: ["--mode", "all"],
  },
};

const RUNNER_VALUE_FLAGS = new Set([
  "--scenario",
  "--family",
  "--task-family",
  "--split",
  "--mode",
  "--execution",
  "--case-timeout-ms",
  "--output",
  "--sut-root",
]);
const RUNNER_BOOLEAN_FLAGS = new Set([
  "--supervise",
]);

function usage() {
  return [
    "Usage:",
    "  node scripts/run-llm-experiment.cjs --init",
    "  node scripts/run-llm-experiment.cjs --list",
    "  node scripts/run-llm-experiment.cjs --suite smoke-text",
    "  node scripts/run-llm-experiment.cjs --suite smoke-multimodal --multimodal-model glm-4.5V --judge-model DeepSeek-V4-Pro",
    "",
    "Experiment flags:",
    "  --init                      Create experiments/llm-experiments.local.json from the example.",
    "  --config <file>             Config path. Defaults to experiments/llm-experiments.local.json if it exists.",
    "  --suite <name>              Suite name from the config. Defaults to defaults.suite.",
    "  --model <key>               Override the suite's primary model.",
    "  --test-model <key>          Override roles.test.",
    "  --multimodal-model <key>    Override roles.multimodal.",
    "  --judge-model <key>         Override roles.judge.",
    "  --dry-run                   Print the resolved command without running it.",
    "  --no-supervise              Run all cases in one process for debugging. Experiments supervise by default.",
    "  --list                      List configured models and suites.",
    "",
    "Runner flags passed through:",
    "  --scenario <id> --family <name> --split <name> --mode <auto|oracle-specialist|generic-only|all>",
    "  --execution <web-stream|full> --case-timeout-ms <milliseconds> --supervise",
    "  --output <file> --sut-root <path>",
  ].join("\n");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read JSON config: ${filePath}\n${detail}`);
  }
}

function parseArgs(argv) {
  const options = {
    configPath: null,
    suiteName: null,
    primaryModelKey: null,
    roleOverrides: {},
    runnerArgs: [],
    dryRun: false,
    noSupervise: false,
    list: false,
    init: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--config") {
      options.configPath = requireValue(argv, ++i, arg);
    } else if (arg === "--suite") {
      options.suiteName = requireValue(argv, ++i, arg);
    } else if (arg === "--model") {
      options.primaryModelKey = requireValue(argv, ++i, arg);
    } else if (arg === "--test-model") {
      options.roleOverrides.test = requireValue(argv, ++i, arg);
    } else if (arg === "--multimodal-model") {
      options.roleOverrides.multimodal = requireValue(argv, ++i, arg);
    } else if (arg === "--judge-model") {
      options.roleOverrides.judge = requireValue(argv, ++i, arg);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--no-supervise") {
      options.noSupervise = true;
    } else if (arg === "--list") {
      options.list = true;
    } else if (arg === "--init") {
      options.init = true;
    } else if (arg === "--") {
      options.runnerArgs.push(...argv.slice(i + 1));
      break;
    } else if (RUNNER_VALUE_FLAGS.has(arg)) {
      options.runnerArgs.push(arg, requireValue(argv, ++i, arg));
    } else if (RUNNER_BOOLEAN_FLAGS.has(arg)) {
      options.runnerArgs.push(arg);
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }

  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function resolveConfigPath(explicitPath) {
  if (explicitPath) return path.resolve(process.cwd(), explicitPath);
  if (fs.existsSync(LOCAL_CONFIG_PATH)) return LOCAL_CONFIG_PATH;
  return EXAMPLE_CONFIG_PATH;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function loadConfig(configPath) {
  const config = readJson(configPath);
  assertObject(config.models, "models");
  return normalizeConfig(config);
}

function normalizeConfig(config) {
  const roles = {
    test: config.testModel || config.roles?.test,
    multimodal: config.multimodalModel || config.roles?.multimodal,
    judge: config.judgeModel || config.roles?.judge,
  };

  return {
    ...config,
    roles,
    defaults: { ...DEFAULT_DEFAULTS, ...(config.defaults || {}) },
    suites: { ...DEFAULT_SUITES, ...(config.suites || {}) },
  };
}

function initLocalConfig() {
  if (fs.existsSync(LOCAL_CONFIG_PATH)) {
    process.stdout.write(`Local config already exists: ${LOCAL_CONFIG_PATH}\n`);
    return;
  }
  fs.mkdirSync(path.dirname(LOCAL_CONFIG_PATH), { recursive: true });
  fs.copyFileSync(EXAMPLE_CONFIG_PATH, LOCAL_CONFIG_PATH);
  process.stdout.write(`Created local config: ${LOCAL_CONFIG_PATH}\n`);
  process.stdout.write("Edit testModel, multimodalModel, judgeModel, and API key env vars before running experiments.\n");
}

function listConfig(config, configPath) {
  process.stdout.write(`Config: ${configPath}\n\n`);
  process.stdout.write("Roles:\n");
  for (const role of ["test", "multimodal", "judge"]) {
    process.stdout.write(`  ${role.padEnd(10)} ${config.roles?.[role] || "(unset)"}\n`);
  }

  process.stdout.write("\nModels:\n");
  for (const [key, model] of Object.entries(config.models || {})) {
    const apiKeyEnv = model.apiKeyEnv || "(unset)";
    const keyStatus = model.apiKeyEnv && process.env[model.apiKeyEnv] ? "set" : "missing";
    process.stdout.write(
      `  ${key.padEnd(18)} ${String(model.model || "").padEnd(18)} ${model.baseUrl || "(no baseUrl)"}  key:${apiKeyEnv}(${keyStatus})\n`,
    );
  }

  process.stdout.write("\nSuites:\n");
  for (const [key, suite] of Object.entries(config.suites || {})) {
    const role = suite.modelRole || "test";
    const args = Array.isArray(suite.runnerArgs) ? suite.runnerArgs.join(" ") : "";
    process.stdout.write(`  ${key.padEnd(18)} role:${role.padEnd(10)} ${args}\n`);
    if (suite.description) {
      process.stdout.write(`    ${suite.description}\n`);
    }
  }
}

function resolveSuite(config, suiteName) {
  const resolvedName = suiteName || config.defaults?.suite;
  if (!resolvedName) {
    throw new Error(`No suite selected.\n\n${usage()}`);
  }
  const suite = config.suites?.[resolvedName];
  if (!suite) {
    throw new Error(`Unknown suite '${resolvedName}'. Use --list to inspect configured suites.`);
  }
  return { suiteName: resolvedName, suite };
}

function resolveRoleKey(config, roleName, roleOverrides) {
  return roleOverrides[roleName] || config.roles?.[roleName] || null;
}

function resolveModel(config, modelKey, roleLabel, requireKey) {
  if (!modelKey) {
    throw new Error(`No model key configured for ${roleLabel}`);
  }
  const raw = config.models?.[modelKey];
  if (!raw) {
    throw new Error(`Unknown model '${modelKey}' for ${roleLabel}. Use --list to inspect configured models.`);
  }
  if (!raw.model) {
    throw new Error(`Model '${modelKey}' is missing required field 'model'`);
  }
  if (!raw.baseUrl) {
    throw new Error(`Model '${modelKey}' is missing required field 'baseUrl'`);
  }
  if (!raw.apiKeyEnv) {
    throw new Error(`Model '${modelKey}' is missing required field 'apiKeyEnv'`);
  }

  const apiKey = process.env[raw.apiKeyEnv];
  if (requireKey && !apiKey) {
    throw new Error(
      `Environment variable ${raw.apiKeyEnv} is required for model '${modelKey}' (${roleLabel}).`,
    );
  }

  return {
    key: modelKey,
    provider: raw.provider || "",
    model: raw.model,
    baseUrl: raw.baseUrl,
    apiKeyEnv: raw.apiKeyEnv,
    apiKey: apiKey || "",
    extraEnv: raw.extraEnv && typeof raw.extraEnv === "object" ? raw.extraEnv : {},
  };
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function sanitizeFilePart(value) {
  return String(value || "unset")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "unset";
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function resolveOutputPath(config, suiteName, primary, judge, runnerArgs) {
  const outputIndex = runnerArgs.indexOf("--output");
  if (outputIndex >= 0 && runnerArgs[outputIndex + 1]) {
    const outputPath = absoluteBenchPath(runnerArgs[outputIndex + 1]);
    runnerArgs[outputIndex + 1] = outputPath;
    ensureOutputDirectory(outputPath);
    return outputPath;
  }

  const outputDir = config.defaults?.outputDir || "results";
  const fileName = [
    sanitizeFilePart(suiteName),
    sanitizeFilePart(primary.key),
    `judge-${sanitizeFilePart(judge.key)}`,
    timestampForFile(),
  ].join("__") + ".json";
  const outputPath = absoluteBenchPath(path.join(outputDir, fileName));
  ensureOutputDirectory(outputPath);
  return outputPath;
}

function ensureOutputDirectory(outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
}

function absoluteBenchPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(BENCH_ROOT, filePath);
}

function resolveRunnerCwd(runnerArgs) {
  const sutRootIndex = runnerArgs.indexOf("--sut-root");
  if (sutRootIndex >= 0 && runnerArgs[sutRootIndex + 1]) {
    return path.resolve(process.cwd(), runnerArgs[sutRootIndex + 1]);
  }
  if (process.env.SCLAW_ROOT) {
    return path.resolve(process.env.SCLAW_ROOT);
  }
  return path.resolve(BENCH_ROOT, "../..");
}

function buildRunnerArgs(config, suite, suiteName, primary, judge, cliRunnerArgs, experimentOptions = {}) {
  let runnerArgs = [
    ...(Array.isArray(suite.runnerArgs) ? suite.runnerArgs : []),
    ...cliRunnerArgs,
  ];

  if (experimentOptions.noSupervise) {
    runnerArgs = runnerArgs.filter((arg) => arg !== "--supervise");
  }

  const defaultMode = config.defaults?.mode;
  if (defaultMode && !hasFlag(runnerArgs, "--mode")) {
    runnerArgs.push("--mode", String(defaultMode));
  }

  const supervise = suite.supervise ?? config.defaults?.supervise;
  if (supervise !== false && !experimentOptions.noSupervise && !hasFlag(runnerArgs, "--supervise")) {
    runnerArgs.push("--supervise");
  }

  const defaultCaseTimeoutMs = config.defaults?.caseTimeoutMs;
  if (defaultCaseTimeoutMs && !hasFlag(runnerArgs, "--case-timeout-ms")) {
    runnerArgs.push("--case-timeout-ms", String(defaultCaseTimeoutMs));
  }

  if (!hasFlag(runnerArgs, "--output")) {
    runnerArgs.push("--output", resolveOutputPath(config, suiteName, primary, judge, runnerArgs));
  } else {
    resolveOutputPath(config, suiteName, primary, judge, runnerArgs);
  }

  return runnerArgs;
}

function buildExperimentEnv(config, suite, primary, judge) {
  const rootEnv = config.environment && typeof config.environment === "object" ? config.environment : {};
  const suiteEnv = suite.environment && typeof suite.environment === "object" ? suite.environment : {};
  const runtimeDir = path.join(RUNTIME_ROOT, sanitizeFilePart(primary.key));
  fs.mkdirSync(runtimeDir, { recursive: true });
  const sourceDataDir = resolveBenchmarkSourceDataDir(rootEnv, suiteEnv);
  syncRuntimeSettings(runtimeDir, sourceDataDir, primary);
  const env = {
    ...process.env,
    ...stringifyEnv(rootEnv),
    ...stringifyEnv(primary.extraEnv),
    LLM_MODEL: primary.model,
    LLM_BASE_URL: primary.baseUrl,
    LLM_API_KEY: primary.apiKey,
    LLM_JUDGE_MODEL: judge.model,
    LLM_JUDGE_BASE_URL: judge.baseUrl,
    LLM_JUDGE_API_KEY: judge.apiKey,
    ...stringifyEnv(judge.extraEnv),
    ...stringifyEnv(suiteEnv),
    SCLAW_DATA_DIR: runtimeDir,
    ...(sourceDataDir ? { SCLAW_BENCHMARK_SOURCE_DATA_DIR: sourceDataDir } : {}),
  };
  return env;
}

function resolveBenchmarkSourceDataDir(rootEnv, suiteEnv) {
  const value = suiteEnv.SCLAW_BENCHMARK_SOURCE_DATA_DIR
    || rootEnv.SCLAW_BENCHMARK_SOURCE_DATA_DIR
    || process.env.SCLAW_BENCHMARK_SOURCE_DATA_DIR
    || process.env.SCLAW_DATA_DIR;
  return value ? path.resolve(String(value)) : null;
}

function syncRuntimeSettings(runtimeDir, sourceDataDir, primary) {
  let settings = {};
  const sourceSettings = sourceDataDir ? path.join(sourceDataDir, "settings.json") : null;
  if (sourceSettings && fs.existsSync(sourceSettings)) {
    settings = readJson(sourceSettings);
  }
  fs.mkdirSync(runtimeDir, { recursive: true });

  settings.llm = {
    ...(settings.llm && typeof settings.llm === "object" && !Array.isArray(settings.llm)
      ? settings.llm
      : {}),
    model: primary.model,
    baseUrl: primary.baseUrl,
  };
  delete settings.llm.apiKey;

  const sourcePython = sourceDataDir
    ? (process.platform === "win32"
        ? path.join(sourceDataDir, ".venv", "Scripts", "python.exe")
        : path.join(sourceDataDir, ".venv", "bin", "python"))
    : null;
  if (sourcePython && fs.existsSync(sourcePython)) {
    settings.analysis = {
      ...(settings.analysis && typeof settings.analysis === "object" && !Array.isArray(settings.analysis)
        ? settings.analysis
        : {}),
      pythonBin: settings.analysis?.pythonBin || sourcePython,
    };
  }
  fs.writeFileSync(path.join(runtimeDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

function stringifyEnv(values) {
  return Object.fromEntries(
    Object.entries(values || {}).map(([key, value]) => [key, String(value)]),
  );
}

function printResolvedRun({ configPath, suiteName, suite, primary, judge, runnerArgs, runnerCwd, dryRun }) {
  const prefix = dryRun ? "Dry run" : "Experiment";
  process.stdout.write(`${prefix}: ${suiteName}\n`);
  process.stdout.write(`Config: ${configPath}\n`);
  if (suite.description) {
    process.stdout.write(`Description: ${suite.description}\n`);
  }
  process.stdout.write(`Primary model: ${primary.key} -> ${primary.model} (${primary.baseUrl})\n`);
  process.stdout.write(`Primary key env: ${primary.apiKeyEnv} (${primary.apiKey ? "set" : "missing"})\n`);
  process.stdout.write(`Judge model: ${judge.key} -> ${judge.model} (${judge.baseUrl})\n`);
  process.stdout.write(`Judge key env: ${judge.apiKeyEnv} (${judge.apiKey ? "set" : "missing"})\n`);
  process.stdout.write(`Runner cwd: ${runnerCwd}\n`);
  process.stdout.write(`Runtime data: ${path.join(RUNTIME_ROOT, sanitizeFilePart(primary.key))}\n`);
  process.stdout.write(`Source data: ${process.env.SCLAW_BENCHMARK_SOURCE_DATA_DIR || process.env.SCLAW_DATA_DIR || "(none)"}\n`);
  process.stdout.write(`Command: node ${path.relative(BENCH_ROOT, RUNNER_PATH)} ${runnerArgs.join(" ")}\n`);
}

function runChild(runnerArgs, env, runnerCwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER_PATH, ...runnerArgs], {
      cwd: runnerCwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Experiment interrupted by signal ${signal}`));
        return;
      }
      resolve(code || 0);
    });
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.init) {
    initLocalConfig();
    return 0;
  }

  const configPath = resolveConfigPath(options.configPath);
  const config = loadConfig(configPath);

  if (options.list) {
    listConfig(config, configPath);
    return 0;
  }

  const { suiteName, suite } = resolveSuite(config, options.suiteName);
  const modelRole = suite.modelRole || "test";
  const primaryModelKey =
    options.primaryModelKey || resolveRoleKey(config, modelRole, options.roleOverrides);
  const judgeModelKey = resolveRoleKey(config, "judge", options.roleOverrides) || primaryModelKey;
  const primary = resolveModel(config, primaryModelKey, `suite '${suiteName}' primary role '${modelRole}'`, !options.dryRun);
  const judge = resolveModel(config, judgeModelKey, "judge", !options.dryRun);
  const runnerArgs = buildRunnerArgs(config, suite, suiteName, primary, judge, options.runnerArgs, options);
  const runnerCwd = resolveRunnerCwd(runnerArgs);

  printResolvedRun({ configPath, suiteName, suite, primary, judge, runnerArgs, runnerCwd, dryRun: options.dryRun });
  if (options.dryRun) {
    return 0;
  }

  const env = buildExperimentEnv(config, suite, primary, judge);
  return await runChild(runnerArgs, env, runnerCwd);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
