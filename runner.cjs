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

const BENCHMARK_MODES = ["auto", "oracle-specialist", "generic-only"];
const EXECUTION_MODES = ["web-stream", "full"];
const DEFAULT_CASE_TIMEOUT_MS = 15 * 60 * 1000;
const BENCHMARK_UTILITY_SKILL_IDS = [
  "validation-structure-model",
  "report-export-builtin",
];

const DEFAULT_MODES_BY_TASK_FAMILY = {
  standard_workflow: BENCHMARK_MODES,
  interactive_robustness: ["auto"],
  multimodal_reverse_engineering: BENCHMARK_MODES,
};

const LEGACY_TASK_FAMILY = {
  "static-analysis": "standard_workflow",
  "error-recovery": "interactive_robustness",
  multimodal: "multimodal_reverse_engineering",
  "reverse-engineering": "multimodal_reverse_engineering",
};

const BENCHMARK_STRUCTURE_TYPE = {
  beam: "beam",
  column: "column",
  "concrete-frame": "concrete-frame",
  "double-span-beam": "continuous-beam",
  frame: "steel-frame",
  generic: "generic",
  "portal-frame": "portal-frame",
  truss: "truss",
};

function deriveBenchmarkStructureType(structureType) {
  return BENCHMARK_STRUCTURE_TYPE[structureType] || structureType || null;
}

function deriveInputModality(scenario) {
  const attachments = Array.isArray(scenario.attachments)
    ? scenario.attachments
    : Array.isArray(scenario.turns)
      ? scenario.turns.flatMap((turn) => Array.isArray(turn.attachments) ? turn.attachments : [])
      : [];
  if (attachments.length === 0) return "text";
  if (attachments.some((item) => String(item.mimeType || "").includes("dxf"))) return "dxf";
  if (attachments.some((item) => String(item.mimeType || "").startsWith("image/"))) return "image";
  return "file";
}

function inferEvaluationFocus(assertions = []) {
  const focus = new Set();
  for (const assertion of assertions) {
    switch (assertion?.type) {
      case "structural_type":
      case "skill_match":
        focus.add("routing");
        break;
      case "has_model":
        focus.add("modeling");
        break;
      case "model_matches":
        focus.add("modeling");
        focus.add("model_match");
        break;
      case "has_analysis":
      case "engine_match":
        focus.add("analysis");
        if (assertion?.type === "engine_match") focus.add("engine_match");
        break;
      case "has_interaction_questions":
      case "should_not_analyze":
      case "no_bad_model":
        focus.add("interaction");
        break;
      case "has_report":
        focus.add("report");
        break;
      case "natural_language":
        focus.add("semantic");
        break;
      default:
        break;
    }
  }
  return [...focus];
}

function collectScenarioAssertions(scenario) {
  if (Array.isArray(scenario.expect?.assertions)) {
    return scenario.expect.assertions;
  }
  if (Array.isArray(scenario.turns)) {
    return scenario.turns.flatMap((turn) => Array.isArray(turn.assertions) ? turn.assertions : []);
  }
  return [];
}

function normalizeScenarioMetadata(scenario) {
  const taskFamily = scenario.taskFamily || LEGACY_TASK_FAMILY[scenario.category] || "standard_workflow";
  const inputModality = scenario.inputModality || deriveInputModality(scenario);
  const skillTarget = scenario.skillTarget || scenario.expect?.skills?.primary || null;
  const structureType = scenario.structureType || skillTarget || null;
  const benchmarkStructureType = scenario.benchmarkStructureType || deriveBenchmarkStructureType(structureType);
  const split = scenario.split || (taskFamily === "multimodal_reverse_engineering" ? "auxiliary" : "core");
  const difficulty = scenario.difficulty || (taskFamily === "standard_workflow" ? "L1" : "L2");
  const evaluationFocus = Array.isArray(scenario.evaluationFocus) && scenario.evaluationFocus.length > 0
    ? scenario.evaluationFocus
    : inferEvaluationFocus(collectScenarioAssertions(scenario));
  if (taskFamily === "interactive_robustness" && !evaluationFocus.includes("interaction")) {
    evaluationFocus.push("interaction");
  }

  return {
    ...scenario,
    split,
    taskFamily,
    inputModality,
    structureType,
    benchmarkStructureType,
    difficulty,
    skillTarget,
    evaluationFocus,
  };
}

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

function collectScenarioFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectScenarioFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith(".json")) return [fullPath];
    return [];
  });
}

function scenarioListFromPayload(parsed, file) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") return [parsed];
  throw new Error(
    `Scenario file must contain a scenario object or an array: ${path.relative(BENCH_ROOT, file)}`,
  );
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
  const files = collectScenarioFiles(scenariosDir);
  let all = [];
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    all.push(...scenarioListFromPayload(parsed, file).map(normalizeScenarioMetadata));
  }
  if (options.scenarioId) {
    all = all.filter((s) => s.id === options.scenarioId);
  }
  if (options.taskFamily) {
    all = all.filter((s) => s.taskFamily === options.taskFamily);
  }
  if (options.split) {
    all = all.filter((s) => s.split === options.split);
  }
  return all;
}

function parseBenchmarkOptions(args) {
  let scenarioId;
  let outputPath;
  let sutRoot;
  let mode = "auto";
  let execution = "web-stream";
  let caseTimeoutMs = Number(process.env.LLM_BENCHMARK_CASE_TIMEOUT_MS || DEFAULT_CASE_TIMEOUT_MS);
  let taskFamily;
  let split;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scenario" && args[i + 1]) {
      scenarioId = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[++i];
    } else if (args[i] === "--sut-root" && args[i + 1]) {
      sutRoot = args[++i];
    } else if (args[i] === "--mode" && args[i + 1]) {
      mode = args[++i];
    } else if (args[i] === "--execution" && args[i + 1]) {
      execution = args[++i];
    } else if (args[i] === "--case-timeout-ms" && args[i + 1]) {
      caseTimeoutMs = Number(args[++i]);
    } else if ((args[i] === "--family" || args[i] === "--task-family") && args[i + 1]) {
      taskFamily = args[++i];
    } else if (args[i] === "--split" && args[i + 1]) {
      split = args[++i];
    }
  }
  if (mode !== "all" && !BENCHMARK_MODES.includes(mode)) {
    throw new Error(`Unsupported benchmark mode: ${mode}. Use one of: ${BENCHMARK_MODES.join(", ")}, all`);
  }
  if (!EXECUTION_MODES.includes(execution)) {
    throw new Error(`Unsupported execution mode: ${execution}. Use one of: ${EXECUTION_MODES.join(", ")}`);
  }
  if (!Number.isFinite(caseTimeoutMs) || caseTimeoutMs <= 0) {
    throw new Error("--case-timeout-ms must be a positive number");
  }
  return { scenarioId, outputPath, sutRoot, mode, execution, caseTimeoutMs, taskFamily, split };
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
  const resolved = {
    ...scenario,
    attachments: resolve(scenario.attachments),
  };
  if (Array.isArray(scenario.turns)) {
    resolved.turns = scenario.turns.map((t) => ({ ...t, attachments: resolve(t.attachments) }));
  }
  return resolved;
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

function safeConversationIdPart(value) {
  return String(value || "scenario").replace(/[^A-Za-z0-9_-]/g, "-");
}

function modesForScenario(scenario) {
  if (Array.isArray(scenario.benchmarkModes) && scenario.benchmarkModes.length > 0) {
    return scenario.benchmarkModes.filter((mode) => BENCHMARK_MODES.includes(mode));
  }
  return DEFAULT_MODES_BY_TASK_FAMILY[scenario.taskFamily] || ["auto"];
}

function resolveScenarioRuns(scenarios, options) {
  return scenarios.flatMap((scenario) => {
    const supportedModes = modesForScenario(scenario);
    const modes = options.mode === "all" ? supportedModes : supportedModes.filter((mode) => mode === options.mode);
    return modes.map((mode) => applyBenchmarkMode(scenario, mode));
  });
}

function assertionsForMode(assertions, mode) {
  if (!Array.isArray(assertions)) return assertions;
  if (mode === "auto") return assertions;
  return assertions
    .filter((assertion) => assertion?.type !== "skill_match" && assertion?.type !== "structural_type")
    .map((assertion) => ({ ...assertion }));
}

function applyBenchmarkMode(scenario, mode) {
  const analysisSkillTarget = scenario.analysisSkillTarget || "opensees-static";
  const scopedSkillIds = mode === "oracle-specialist"
    ? [scenario.skillTarget, analysisSkillTarget].filter(Boolean)
    : mode === "generic-only"
      ? ["generic", analysisSkillTarget]
      : undefined;
  const clone = {
    ...scenario,
    baseScenarioId: scenario.id,
    mode,
    scopedSkillIds,
    id: `${scenario.id}#${mode}`,
  };
  if (Array.isArray(scenario.turns)) {
    clone.turns = scenario.turns.map((turn) => ({
      ...turn,
      assertions: assertionsForMode(turn.assertions, mode),
    }));
  }
  if (scenario.expect?.assertions) {
    clone.expect = {
      ...scenario.expect,
      assertions: assertionsForMode(scenario.expect.assertions, mode),
    };
  }
  return clone;
}

async function buildBenchmarkCapabilityContext(runtime, LangGraphAgentService) {
  const manifests = await runtime.listSkillManifests();
  const protocol = LangGraphAgentService.getProtocol();
  const enabledToolIds = protocol.tools
    .filter((toolDef) => toolDef.defaultEnabled)
    .map((toolDef) => toolDef.name);
  return { manifests, enabledToolIds };
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0))];
}

function resolveBenchmarkSkillIds(scenario, manifests) {
  const availableSkillIds = new Set(manifests.map((manifest) => manifest.id));
  const structureSkillIds = manifests
    .filter((manifest) => manifest.domain === "structure-type")
    .map((manifest) => manifest.id);
  const analysisSkillTarget = scenario.analysisSkillTarget || "opensees-static";
  const utilitySkillIds = BENCHMARK_UTILITY_SKILL_IDS.filter((skillId) => availableSkillIds.has(skillId));

  const structureScope = scenario.mode === "oracle-specialist"
    ? [scenario.skillTarget || scenario.structureType]
    : scenario.mode === "generic-only"
      ? ["generic"]
      : structureSkillIds;

  return uniqueStrings([
    ...structureScope,
    analysisSkillTarget,
    ...utilitySkillIds,
  ]).filter((skillId) => availableSkillIds.has(skillId));
}

function buildTurnContext({ scenario, turn, benchmarkContext, skillIds }) {
  return {
    locale: scenario.locale || "zh",
    skillIds,
    enabledToolIds: benchmarkContext.enabledToolIds,
    attachments: turn.attachments || scenario.attachments,
  };
}

async function runAgentLikeWeb(service, input) {
  for await (const _chunk of service.runStream(input)) {
    // Drain the stream exactly like the browser does; evaluation reads the
    // final graph state from the checkpoint below.
  }
  const snapshot = await service.getConversationSessionSnapshot(
    input.conversationId,
    input.context?.locale || "zh",
  );
  if (!snapshot?.state) {
    throw new Error("web-stream execution did not produce a checkpoint state");
  }
  return snapshot.state;
}

async function runAgentForBenchmark(service, input, execution) {
  if (execution === "full") {
    return service.runFull(input);
  }
  return runAgentLikeWeb(service, input);
}

function createCaseTimeout(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`case timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  if (typeof timeout.unref === "function") {
    timeout.unref();
  }
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
    timedOut: () => controller.signal.aborted,
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
    baseScenarioId: scenario.baseScenarioId || scenario.id,
    description: scenario.description || "",
    split: scenario.split || "core",
    taskFamily: scenario.taskFamily || "standard_workflow",
    inputModality: scenario.inputModality || "text",
    structureType: scenario.structureType || null,
    benchmarkStructureType: scenario.benchmarkStructureType || null,
    difficulty: scenario.difficulty || null,
    skillTarget: scenario.skillTarget || null,
    category: scenario.category || null,
    tags: Array.isArray(scenario.tags) ? scenario.tags : [],
    locale: scenario.locale || null,
    analysisSkillTarget: scenario.analysisSkillTarget || null,
    analysisEngineTarget: scenario.analysisEngineTarget || null,
    mode: scenario.mode || "auto",
    evaluationFocus: Array.isArray(scenario.evaluationFocus) ? scenario.evaluationFocus : [],
    passed: passed + 1,
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

  const scenarios = resolveScenarioRuns(loadScenarios(options), options);
  if (scenarios.length === 0) {
    process.stdout.write("No benchmark scenarios matched.\n");
    return;
  }

  process.stdout.write(`\n${"=".repeat(60)}\n`);
  process.stdout.write(`LangGraph Agent Benchmark: ${scenarios.length} scenario run(s)\n`);
  process.stdout.write(`Mode: ${options.mode}\n`);
  process.stdout.write(`Execution: ${options.execution}\n`);
  process.stdout.write(`Case timeout: ${options.caseTimeoutMs}ms\n`);
  process.stdout.write(`SUT root: ${sutRoot}\n`);
  process.stdout.write(`Model: ${context.env.LLM_MODEL || "(default)"}\n`);
  process.stdout.write(`Base URL: ${context.env.LLM_BASE_URL || "(default)"}\n`);
  process.stdout.write(`${"=".repeat(60)}\n`);

  const { AgentSkillRuntime, LangGraphAgentService } = await importBackendModules(sutRoot);
  const runtime = new AgentSkillRuntime();
  const service = new LangGraphAgentService(runtime);
  const benchmarkContext = await buildBenchmarkCapabilityContext(runtime, LangGraphAgentService);

  const results = [];

  for (const rawScenario of scenarios) {
    const scenario = normalizeScenario(resolveAttachmentPaths(rawScenario));
    const skillIds = resolveBenchmarkSkillIds(scenario, benchmarkContext.manifests);
    const maxRetries = Math.max(0, typeof scenario.maxRetries === "number" ? scenario.maxRetries : 0);
    let attempt = 0;
    let lastEvaluation = null;
    const attemptRounds = [];
    const caseTimeout = createCaseTimeout(options.caseTimeoutMs);

    try {
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
        let currentTurnIndex = 0;
        const conversationId = `bench-${safeConversationIdPart(scenario.id)}-${scenarioStart}-${attempt}`;

        const prevLogLevel = process.env.LOG_LEVEL;
        process.env.LOG_LEVEL = "warn";

        try {
          for (let i = 0; i < scenario.turns.length; i++) {
            currentTurnIndex = i;
            const turn = scenario.turns[i];
            const turnStart = Date.now();

            const messageWithFeedback = (i === 0 && feedbackPrefix)
              ? feedbackPrefix + "\n\n" + turn.message
              : turn.message;

            const state = await runAgentForBenchmark(service, {
              message: messageWithFeedback,
              conversationId,
              signal: caseTimeout.signal,
              context: buildTurnContext({ scenario, turn, benchmarkContext, skillIds }),
            }, options.execution);

            const turnDurationMs = Date.now() - turnStart;

            if (turn.assertions && turn.assertions.length > 0) {
              const turnScenario = { ...scenario, expect: { assertions: turn.assertions } };
              const evaluation = await evaluateScenario(turnScenario, state, turnDurationMs);
              turnResults.push({ turnIndex: i, evaluation });
            }
          }
        } catch (err) {
          executionError = true;
          const errorMessage = err instanceof Error ? err.message : String(err);
          const message = caseTimeout.timedOut()
            ? `case timed out after ${options.caseTimeoutMs}ms`
            : errorMessage;
          process.stdout.write(`  error: ${message}\n`);
          turnResults.push({
            turnIndex: currentTurnIndex,
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

        if (lastEvaluation) {
          attemptRounds.push({
            attempt: attempt + 1,
            allPassed: lastEvaluation.allPassed,
            metrics: (lastEvaluation.metrics || []).map((m) => ({ metric: m.metric, pass: m.pass })),
          });
        }
        if (lastEvaluation && lastEvaluation.allPassed) break;
        if (executionError) break;
        attempt += 1;
      }
    } finally {
      caseTimeout.clear();
    }

    if (lastEvaluation) {
      lastEvaluation.executionProfile = {
        execution: options.execution,
        mode: scenario.mode || "auto",
        skillIds,
        enabledToolIds: benchmarkContext.enabledToolIds,
        sourceDataDir: process.env.SCLAW_BENCHMARK_SOURCE_DATA_DIR || null,
        runtimeDataDir: process.env.SCLAW_DATA_DIR || null,
        analysisSkillTarget: scenario.analysisSkillTarget || "opensees-static",
        caseTimeoutMs: options.caseTimeoutMs,
      };
      const attempts = attemptRounds.length;
      lastEvaluation.retries = {
        attempts,
        maxRetries,
        retriesUsed: Math.max(0, attempts - 1),
        passAt1: attemptRounds[0]?.allPassed === true,
        passAtN: lastEvaluation.allPassed === true,
        rounds: attemptRounds,
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
    if (options.outputPath) {
      writeJsonOutput(options.outputPath, results, { quiet: true });
    }
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
