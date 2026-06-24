const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BENCH_ROOT = path.resolve(__dirname, "..");
const EXPERIMENT_SCRIPT = path.join(__dirname, "run-llm-experiment.cjs");

const RUNNER_VALUE_FLAGS = new Set([
  "--scenario",
  "--family",
  "--task-family",
  "--split",
  "--execution",
  "--case-timeout-ms",
  "--sut-root",
]);

const RUNNER_BOOLEAN_FLAGS = new Set([
  "--supervise",
  "--no-supervise",
]);

function usage() {
  return [
    "Usage:",
    "  node scripts/run-llm-experiment-batch.cjs --suite standard --models glm-5-turbo,glm-5.2 --modes auto,generic-only",
    "",
    "Batch flags:",
    "  --config <file>             Config path passed to run-llm-experiment.cjs.",
    "  --suite <name>              Suite name. Defaults to smoke-text.",
    "  --model <key>               Add one model key. Can be repeated.",
    "  --models <a,b,c>            Add comma-separated model keys.",
    "  --mode <name>               Add one benchmark mode. Can be repeated.",
    "  --modes <a,b,c>             Add comma-separated benchmark modes. Defaults to auto.",
    "  --judge-model <key>         Override the judge role.",
    "  --multimodal-model <key>    Override the multimodal role.",
    "  --name <file-prefix>        Batch log/summary prefix. Defaults to the suite name.",
    "  --run-id <id>               Stable run id. Defaults to a timestamp.",
    "  --output-dir <dir>          Result directory under the benchmark root. Defaults to results.",
    "  --dry-run                   Resolve and print each command without running scenarios.",
    "  --stop-on-error             Stop after the first failed model/mode pair.",
    "",
    "Runner flags passed through:",
    "  --scenario <id> --family <name> --split <name>",
    "  --execution <web-stream|full> --case-timeout-ms <milliseconds>",
    "  --sut-root <path> --supervise --no-supervise",
    "",
    "Additional run-llm-experiment.cjs runner flags can be appended after --.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    configPath: null,
    suite: "smoke-text",
    models: [],
    modes: [],
    judgeModel: null,
    multimodalModel: null,
    name: null,
    runId: timestampForFile(),
    outputDir: "results",
    runnerArgs: [],
    dryRun: false,
    stopOnError: false,
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
      options.suite = requireValue(argv, ++i, arg);
    } else if (arg === "--model") {
      options.models.push(requireValue(argv, ++i, arg));
    } else if (arg === "--models") {
      options.models.push(...splitList(requireValue(argv, ++i, arg)));
    } else if (arg === "--mode") {
      options.modes.push(requireValue(argv, ++i, arg));
    } else if (arg === "--modes") {
      options.modes.push(...splitList(requireValue(argv, ++i, arg)));
    } else if (arg === "--judge-model") {
      options.judgeModel = requireValue(argv, ++i, arg);
    } else if (arg === "--multimodal-model") {
      options.multimodalModel = requireValue(argv, ++i, arg);
    } else if (arg === "--name") {
      options.name = requireValue(argv, ++i, arg);
    } else if (arg === "--run-id") {
      options.runId = requireValue(argv, ++i, arg);
    } else if (arg === "--output-dir") {
      options.outputDir = requireValue(argv, ++i, arg);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--stop-on-error") {
      options.stopOnError = true;
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

  options.models = uniqueNonEmpty(options.models);
  options.modes = uniqueNonEmpty(options.modes.length > 0 ? options.modes : ["auto"]);
  if (options.models.length === 0) {
    throw new Error(`At least one --model or --models value is required.\n\n${usage()}`);
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

function splitList(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitizeFilePart(value) {
  return String(value || "unset")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "unset";
}

function absoluteBenchPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(BENCH_ROOT, filePath);
}

function buildPaths(options) {
  const outputDir = absoluteBenchPath(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const batchName = sanitizeFilePart(options.name || options.suite);
  const runId = sanitizeFilePart(options.runId);
  return {
    outputDir,
    batchName,
    runId,
    logPath: path.join(outputDir, `${batchName}__${runId}.log`),
    summaryPath: path.join(outputDir, `${batchName}__${runId}.summary.json`),
  };
}

function resultPath(paths, suite, model, mode) {
  const fileName = [
    sanitizeFilePart(suite),
    sanitizeFilePart(model),
    sanitizeFilePart(mode),
    paths.runId,
  ].join("__") + ".json";
  return path.join(paths.outputDir, fileName);
}

function buildChildArgs(options, outputPath, model, mode) {
  const args = [EXPERIMENT_SCRIPT, "--suite", options.suite, "--model", model];
  if (options.configPath) {
    args.push("--config", options.configPath);
  }
  if (options.judgeModel) {
    args.push("--judge-model", options.judgeModel);
  }
  if (options.multimodalModel) {
    args.push("--multimodal-model", options.multimodalModel);
  }
  if (options.dryRun) {
    args.push("--dry-run");
  }
  args.push("--mode", mode, "--output", outputPath, ...options.runnerArgs);
  return args;
}

function writeSummary(summaryPath, summary) {
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function stripAnsi(value) {
  return String(value).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function appendLog(logPath, value) {
  fs.appendFileSync(logPath, stripAnsi(value), "utf8");
}

function writeLog(logPath, line) {
  const text = `${line}\n`;
  appendLog(logPath, text);
  process.stdout.write(stripAnsi(text));
}

function runChild(args, logPath) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    const child = spawn(process.execPath, args, {
      cwd: BENCH_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      appendLog(logPath, chunk);
      process.stdout.write(stripAnsi(chunk));
    });
    child.stderr.on("data", (chunk) => {
      appendLog(logPath, chunk);
      process.stderr.write(stripAnsi(chunk));
    });
    child.on("error", (err) => {
      resolve({
        status: "failed",
        exitCode: 1,
        error: err instanceof Error ? err.message : String(err),
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
      });
    });
    child.on("exit", (code, signal) => {
      const exitCode = typeof code === "number" ? code : 1;
      resolve({
        status: signal ? "failed" : (exitCode === 0 ? "passed" : "failed"),
        exitCode,
        signal: signal || null,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
      });
    });
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  const paths = buildPaths(options);
  const jobs = [];
  for (const mode of options.modes) {
    for (const model of options.models) {
      const outputPath = resultPath(paths, options.suite, model, mode);
      jobs.push({
        model,
        mode,
        outputPath,
        args: buildChildArgs(options, outputPath, model, mode),
        status: "pending",
      });
    }
  }

  const summary = {
    runId: paths.runId,
    suite: options.suite,
    models: options.models,
    modes: options.modes,
    dryRun: options.dryRun,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logPath: paths.logPath,
    summaryPath: paths.summaryPath,
    jobs,
  };
  writeSummary(paths.summaryPath, summary);

  writeLog(paths.logPath, `[${summary.startedAt}] Batch start suite=${options.suite} models=${options.models.length} modes=${options.modes.join(",")} jobs=${jobs.length}`);
  writeLog(paths.logPath, `Summary: ${paths.summaryPath}`);

  for (const job of jobs) {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    writeSummary(paths.summaryPath, summary);
    writeLog(paths.logPath, `[${job.startedAt}] BEGIN model=${job.model} mode=${job.mode} output=${job.outputPath}`);
    writeLog(paths.logPath, `Command: ${process.execPath} ${job.args.join(" ")}`);
    const result = await runChild(job.args, paths.logPath);
    Object.assign(job, result);
    if (options.dryRun && job.status === "passed") {
      job.status = "dry-run";
    }
    writeSummary(paths.summaryPath, summary);
    writeLog(paths.logPath, `[${job.finishedAt}] END model=${job.model} mode=${job.mode} status=${job.status} exit=${job.exitCode}`);

    if (job.status === "failed" && options.stopOnError) {
      break;
    }
  }

  summary.finishedAt = new Date().toISOString();
  writeSummary(paths.summaryPath, summary);
  writeLog(paths.logPath, `[${summary.finishedAt}] Batch finish failures=${jobs.filter((job) => job.status === "failed").length}`);

  return jobs.some((job) => job.status === "failed") ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
