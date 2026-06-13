const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const { evaluateScenario } = require("./lib/evaluate.cjs");
const { printScenarioResult, printSummary, writeJsonOutput } = require("./lib/report.cjs");

// Resolve the System-Under-Test root (the structureclaw main repo).
// Priority: SCLAW_ROOT env > parent-of-parent (works when this repo is checked
// out as a submodule under <main>/tests/llm-benchmark).
const BENCH_ROOT = __dirname;
const SCLAW_ROOT = process.env.SCLAW_ROOT
  || path.resolve(BENCH_ROOT, "../..");

function resolveSutRoot(explicit) {
  const root = explicit || SCLAW_ROOT;
  const marker = path.join(root, "backend", "package.json");
  if (!fs.existsSync(marker)) {
    throw new Error(
      `SCLAW_ROOT does not look like a structureclaw checkout: ${root}\n` +
      `Set SCLAW_ROOT env var to the structureclaw repo root.`,
    );
  }
  return root;
}

async function importBackendModules(sutRoot) {
  const runtimePath = path.join(sutRoot, "backend", "dist", "agent-runtime", "index.js");
  const servicePath = path.join(sutRoot, "backend", "dist", "agent-langgraph", "agent-service.js");

  const runtimeMod = await import(pathToFileURL(runtimePath).href);
  const serviceMod = await import(`${pathToFileURL(servicePath).href}?bench=${Date.now()}`);

  return {
    AgentSkillRuntime: runtimeMod.AgentSkillRuntime,
    LangGraphAgentService: serviceMod.LangGraphAgentService,
  };
}

function loadScenarios(options) {
  const scenariosDir = path.join(BENCH_ROOT, "scenarios");
  const files = fs.readdirSync(scenariosDir).filter((f) => f.endsWith(".json")).sort();
  let all = [];
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(path.join(scenariosDir, file), "utf-8"));
    all.push(...parsed);
  }
  if (options.scenarioId) {
    all = all.filter((s) => s.id === options.scenarioId);
  }
  return all;
}

function parseBenchmarkOptions(args) {
  let scenarioId;
  let outputPath;
  let sutRoot;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scenario" && args[i + 1]) {
      scenarioId = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[++i];
    } else if (args[i] === "--sut-root" && args[i + 1]) {
      sutRoot = args[++i];
    }
  }
  return { scenarioId, outputPath, sutRoot };
}

function buildFeedbackFromEvaluation(evaluation, locale = "zh") {
  const isEn = locale === "en";
  const failed = (evaluation.metrics || []).filter(
    (m) => !m.pass && m.metric !== "duration" && m.metric !== "toolCalls",
  );
  if (failed.length === 0) return "";
  const details = failed.map(
    (m) => isEn
      ? `${m.metric} check failed: expected ${m.expected}, got ${m.actual}`
      : `${m.metric} 检查失败：期望 ${m.expected}，实际得到 ${m.actual}`,
  ).join(isEn ? "; " : "；");
  return isEn
    ? `Previous attempt failed: ${details}. Please fix these issues.`
    : `上次尝试失败：${details}。请修正以上问题。`;
}

function resolveAttachmentPaths(scenario) {
  const resolve = (attachments) => {
    if (!attachments) return attachments;
    return attachments.map((a) => {
      if (path.isAbsolute(a.relPath)) return a;
      // Strip legacy "tests/llm-benchmark/" prefix if present, then resolve
      // relative to this benchmark repo root.
      const rel = a.relPath.replace(/^tests\/llm-benchmark\//, "");
      return { ...a, relPath: path.resolve(BENCH_ROOT, rel) };
    });
  };
  return {
    ...scenario,
    attachments: resolve(scenario.attachments),
    turns: (scenario.turns || []).map((t) => ({ ...t, attachments: resolve(t.attachments) })),
  };
}

function normalizeScenario(scenario) {
  if (scenario.turns) {
    return { ...scenario, _multiTurn: true };
  }
  return {
    ...scenario,
    _multiTurn: false,
    turns: [
      {
        message: scenario.message,
        assertions: scenario.expect?.assertions,
        attachments: scenario.attachments,
      },
    ],
  };
}

function mergeTurnResults(scenario, turnResults, totalDurationMs) {
  const allMetrics = [];
  let allPassed = true;
  let passed = 0;
  let total = 0;

  for (const { evaluation } of turnResults) {
    const coreMetrics = evaluation.metrics.filter(
      (m) => m.metric !== "toolCalls" && m.metric !== "duration",
    );
    allMetrics.push(...coreMetrics);
    passed += coreMetrics.filter((m) => m.pass).length;
    total += coreMetrics.length;
    if (!evaluation.allPassed) allPassed = false;
  }

  allMetrics.push({
    metric: "duration",
    pass: true,
    expected: "(info)",
    actual: `${(totalDurationMs / 1000).toFixed(1)}s`,
  });

  return {
    scenarioId: scenario.id,
    description: scenario.description || "",
    passed,
    total: total + 1,
    allPassed,
    metrics: allMetrics,
    durationMs: totalDurationMs,
    turnResults: turnResults.map((r) => ({ turnIndex: r.turnIndex, evaluation: r.evaluation })),
  };
}

async function runBenchmark(args) {
  const options = parseBenchmarkOptions(args);
  const sutRoot = resolveSutRoot(options.sutRoot);

  // Reuse SUT's regression helpers for env setup and backend build.
  const regressionSharedPath = path.join(sutRoot, "tests", "regression", "shared.js");
  const { resolveRegressionContext, runBackendBuildOnce } = require(regressionSharedPath);
  const context = resolveRegressionContext(sutRoot);

  for (const [k, v] of Object.entries(context.env)) {
    if (v !== undefined && v !== "") {
      process.env[k] = v;
    }
  }

  await runBackendBuildOnce(context);

  const { execSync } = require("node:child_process");
  execSync("npx prisma db push --accept-data-loss", {
    cwd: path.join(sutRoot, "backend"),
    env: { ...process.env, ...context.env },
    stdio: "pipe",
  });

  const scenarios = loadScenarios(options);
  if (scenarios.length === 0) {
    process.stdout.write("No benchmark scenarios matched.\n");
    return;
  }

  process.stdout.write(`\n${"=".repeat(60)}\n`);
  process.stdout.write(`LangGraph Agent Benchmark: ${scenarios.length} scenario(s)\n`);
  process.stdout.write(`SUT root: ${sutRoot}\n`);
  process.stdout.write(`Model: ${context.env.LLM_MODEL || "(default)"}\n`);
  process.stdout.write(`Base URL: ${context.env.LLM_BASE_URL || "(default)"}\n`);
  process.stdout.write(`${"=".repeat(60)}\n`);

  const { AgentSkillRuntime, LangGraphAgentService } = await importBackendModules(sutRoot);
  const runtime = new AgentSkillRuntime();
  const service = new LangGraphAgentService(runtime);

  const results = [];

  for (const rawScenario of scenarios) {
    const scenario = normalizeScenario(resolveAttachmentPaths(rawScenario));
    const maxRetries = Math.max(0, typeof scenario.maxRetries === "number" ? scenario.maxRetries : 0);
    let attempt = 0;
    let lastEvaluation = null;
    const retryRounds = [];

    while (attempt <= maxRetries) {
      let feedbackPrefix = "";
      if (attempt > 0 && lastEvaluation) {
        feedbackPrefix = buildFeedbackFromEvaluation(lastEvaluation, scenario.locale || "zh");
        if (feedbackPrefix) {
          process.stdout.write(`  Feedback: ${feedbackPrefix.slice(0, 100)}...\n`);
        }
      }

      if (attempt > 0) {
        process.stdout.write(`  Retrying (attempt ${attempt + 1}/${maxRetries + 1})...\n`);
      } else {
        process.stdout.write(`\nRunning: ${scenario.id}...\n`);
      }

      const scenarioStart = Date.now();
      let executionError = false;
      const turnResults = [];
      const conversationId = `bench-${scenario.id}-${scenarioStart}-${attempt}`;

      const prevLogLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = "warn";

      try {
        for (let i = 0; i < scenario.turns.length; i++) {
          const turn = scenario.turns[i];
          const turnStart = Date.now();

          const messageWithFeedback = (i === 0 && feedbackPrefix)
            ? feedbackPrefix + "\n\n" + turn.message
            : turn.message;

          const state = await service.runFull({
            message: messageWithFeedback,
            conversationId,
            context: {
              locale: scenario.locale || "zh",
              attachments: turn.attachments || scenario.attachments,
            },
          });

          const turnDurationMs = Date.now() - turnStart;

          if (turn.assertions && turn.assertions.length > 0) {
            const turnScenario = { ...scenario, expect: { assertions: turn.assertions } };
            const evaluation = await evaluateScenario(turnScenario, state, turnDurationMs);
            turnResults.push({ turnIndex: i, evaluation });
          }
        }
      } catch (err) {
        executionError = true;
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(`  error: ${message}\n`);
        turnResults.push({
          turnIndex: scenario.turns.length - 1,
          evaluation: {
            scenarioId: scenario.id,
            description: scenario.description || "",
            passed: 0,
            total: 1,
            allPassed: false,
            metrics: [{ metric: "execution", pass: false, expected: "no error", actual: message }],
            durationMs: Date.now() - scenarioStart,
          },
        });
      } finally {
        if (prevLogLevel === undefined) {
          delete process.env.LOG_LEVEL;
        } else {
          process.env.LOG_LEVEL = prevLogLevel;
        }
      }

      const totalDurationMs = Date.now() - scenarioStart;

      if (turnResults.length > 0) {
        if (scenario._multiTurn) {
          lastEvaluation = mergeTurnResults(scenario, turnResults, totalDurationMs);
        } else {
          lastEvaluation = turnResults[0].evaluation;
        }
      }

      if (lastEvaluation && lastEvaluation.allPassed) break;
      if (executionError) break;
      if (lastEvaluation) {
        retryRounds.push({
          attempt: attempt + 1,
          allPassed: lastEvaluation.allPassed,
          metrics: (lastEvaluation.metrics || []).map((m) => ({ metric: m.metric, pass: m.pass })),
        });
      }
      attempt += 1;
    }

    if (lastEvaluation) {
      lastEvaluation.retries = {
        attempts: Math.min(attempt + 1, maxRetries + 1),
        maxRetries,
        rounds: retryRounds,
      };
    }

    if (!lastEvaluation) {
      lastEvaluation = {
        scenarioId: scenario.id,
        description: scenario.description || "",
        passed: 0,
        total: 1,
        allPassed: false,
        metrics: [{ metric: "execution", pass: false, expected: "no evaluation produced", actual: "(none)" }],
        durationMs: 0,
      };
    }

    printScenarioResult(rawScenario, lastEvaluation);
    results.push(lastEvaluation);
  }

  printSummary(results);

  if (options.outputPath) {
    writeJsonOutput(options.outputPath, results);
  }

  if (results.some((r) => !r.allPassed)) {
    process.exitCode = 1;
  }
}

module.exports = { runBenchmark };

if (require.main === module) {
  runBenchmark(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
