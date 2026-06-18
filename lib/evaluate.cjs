/**
 * Evaluate a completed AgentState against a scenario's expectations.
 *
 * Supports v2 assertions (type-dispatched) with automatic v1 backward compatibility.
 * Returns a structured result with per-metric pass/fail and an overall score.
 *
 * evaluateScenario is async because natural_language assertions use LLM-as-Judge.
 */

const { extractSkillTrace } = require("./skill-trace.cjs");
const { evaluateNaturalLanguage } = require("./judge.cjs");
const path = require("node:path");
const fs = require("node:fs");

// Lazy-load ground-truth models for model_matches assertions
let _groundTruthCache = null;
function getGroundTruthModels() {
  if (!_groundTruthCache) {
    const gtPath = path.join(__dirname, "..", "fixtures", "ground-truth-models.json");
    if (fs.existsSync(gtPath)) {
      _groundTruthCache = JSON.parse(fs.readFileSync(gtPath, "utf-8"));
    } else {
      _groundTruthCache = [];
    }
  }
  return _groundTruthCache;
}

const ANALYSIS_RESULT_KEYS = [
  "displacements", "nodeDisplacements", "reactions",
  "nodeReactions", "memberForces", "forces",
];

// ---------------------------------------------------------------------------
// v1 → v2 auto-upgrade
// ---------------------------------------------------------------------------

/**
 * Upgrade a v1 scenario expect object to the v2 assertions array format.
 * v2 format is used when `expect.assertions` is already present.
 *
 * @param {object} expect - scenario.expect
 * @returns {{ assertions: object[] }}
 */
function upgradeExpect(expect) {
  if (Array.isArray(expect.assertions)) {
    return { assertions: expect.assertions };
  }

  // v1 → v2 conversion
  const assertions = [];

  if (expect.structuralType) {
    assertions.push({ type: "structural_type", expected: expect.structuralType });
  }
  if (expect.hasModel) {
    assertions.push({
      type: "has_model",
      minNodes: expect.minNodes ?? 2,
      minElements: expect.minElements ?? 1,
    });
  }
  if (expect.hasAnalysis) {
    assertions.push({ type: "has_analysis" });
  }
  if (expect.hasReport) {
    assertions.push({ type: "has_report" });
  }

  return { assertions };
}

// ---------------------------------------------------------------------------
// Typed assertion evaluators
// ---------------------------------------------------------------------------

function evalStructuralType(assertion, state) {
  const actual = state.structuralTypeKey || null;
  return {
    metric: "structural_type",
    pass: actual === assertion.expected,
    expected: assertion.expected,
    actual: actual || "(none)",
  };
}

function evalHasModel(assertion, state) {
  const model = state.model;
  const nodes = Array.isArray(model?.nodes) ? model.nodes : [];
  const elements = Array.isArray(model?.elements) ? model.elements : [];
  const minNodes = assertion.minNodes ?? 2;
  const minElements = assertion.minElements ?? 1;
  return {
    metric: "has_model",
    pass: !!model && nodes.length >= minNodes && elements.length >= minElements,
    expected: `>= ${minNodes} nodes, >= ${minElements} elements`,
    actual: model ? `${nodes.length} nodes, ${elements.length} elements` : "(none)",
  };
}

function hasResultField(obj, names) {
  if (!obj || typeof obj !== "object") return false;
  for (const name of names) {
    const val = obj[name];
    if (!val) continue;
    if (Array.isArray(val) && val.length > 0) return true;
    if (typeof val === "object" && Object.keys(val).length > 0) return true;
  }
  return false;
}

function evalHasAnalysis(_assertion, state) {
  const analysis = state.analysisResult;
  if (!analysis) {
    return {
      metric: "has_analysis",
      pass: false,
      expected: "analysis results present",
      actual: "(none)",
    };
  }
  const pass = hasResultField(analysis, ANALYSIS_RESULT_KEYS) || hasResultField(analysis.data, ANALYSIS_RESULT_KEYS);
  return {
    metric: "has_analysis",
    pass,
    expected: "analysis results with displacements, reactions, or forces",
    actual: pass ? "present" : `keys: ${Object.keys(analysis).join(", ") || "(empty)"}`,
  };
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function firstStringFromArray(value) {
  return Array.isArray(value)
    ? value.find((item) => typeof item === "string" && item.trim().length > 0) || null
    : null;
}

function extractAnalysisSelection(state) {
  const analysis = asRecord(state.analysisResult);
  const data = asRecord(analysis?.data);
  const meta = asRecord(analysis?.meta);
  const dataMeta = asRecord(data?.meta);
  return {
    engineId: firstString(meta?.engineId, dataMeta?.engineId, analysis?.engineId, data?.engineId),
    analysisSkillId: firstString(
      meta?.analysisSkillId,
      dataMeta?.analysisSkillId,
      firstStringFromArray(meta?.analysisSkillIds),
      firstStringFromArray(dataMeta?.analysisSkillIds),
    ),
    adapterKey: firstString(meta?.analysisAdapterKey, dataMeta?.analysisAdapterKey, meta?.adapterKey, dataMeta?.adapterKey),
  };
}

function evalEngineMatch(assertion, state) {
  const actual = extractAnalysisSelection(state);
  const expectedEngine = assertion.expected || assertion.engineId || null;
  const expectedSkill = assertion.skillId || assertion.analysisSkillId || null;
  const enginePass = !expectedEngine || actual.engineId === expectedEngine;
  const skillPass = !expectedSkill || actual.analysisSkillId === expectedSkill;
  return {
    metric: "engine_match",
    pass: enginePass && skillPass,
    expected: [
      expectedEngine ? `engine=${expectedEngine}` : null,
      expectedSkill ? `skill=${expectedSkill}` : null,
    ].filter(Boolean).join(", ") || "(any analysis engine)",
    actual: [
      `engine=${actual.engineId || "(none)"}`,
      `skill=${actual.analysisSkillId || "(none)"}`,
      actual.adapterKey ? `adapter=${actual.adapterKey}` : null,
    ].filter(Boolean).join(", "),
  };
}

function evalHasReport(_assertion, state) {
  const report = state.report;
  const mdLength = typeof report?.markdown === "string" ? report.markdown.length : 0;
  return {
    metric: "has_report",
    pass: mdLength > 100,
    expected: "markdown > 100 chars",
    actual: report ? `${mdLength} chars` : "(none)",
  };
}

function evalSkillMatch(assertion, state) {
  const trace = extractSkillTrace(Array.isArray(state.messages) ? state.messages : []);
  const actual = trace?.skillId || null;
  const primary = assertion.primary;
  const mayAlsoMatch = Array.isArray(assertion.mayAlsoMatch) ? assertion.mayAlsoMatch : [];
  const allowed = primary ? [primary, ...mayAlsoMatch] : mayAlsoMatch;

  // If no allowed skills specified, match any non-null skill
  if (allowed.length === 0) {
    return {
      metric: "skill_match",
      pass: actual !== null,
      expected: "(any skill)",
      actual: actual || "(none)",
    };
  }

  const pass = actual !== null && allowed.includes(actual);
  return {
    metric: "skill_match",
    pass,
    expected: primary ? `${primary}${mayAlsoMatch.length ? ` (or: ${mayAlsoMatch.join(", ")})` : ""}` : "(any)",
    actual: actual || "(none)",
  };
}

function evalHasInteractionQuestions(_assertion, state) {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const hasQuestions = messages.some((msg) => {
    if (msg.type !== "ai" && msg.role !== "assistant") return false;
    if (Array.isArray(msg.tool_calls)) {
      return msg.tool_calls.some(
        (tc) => tc.name === "ask_user_clarification",
      );
    }
    return false;
  });
  return {
    metric: "has_interaction_questions",
    pass: hasQuestions,
    expected: "agent asks user for missing parameters",
    actual: hasQuestions ? "questions found" : "no questions asked",
  };
}

function hasToolResult(messages, toolName) {
  return messages.some((msg) => msg && typeof msg === "object" && msg.name === toolName);
}

function evalShouldNotAnalyze(_assertion, state) {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const hasAnalysisResult = !!state.analysisResult;
  const ranAnalysisTool = hasToolResult(messages, "run_analysis");
  const pass = !hasAnalysisResult && !ranAnalysisTool;
  return {
    metric: "should_not_analyze",
    pass,
    expected: "no analysis result or run_analysis call",
    actual: pass
      ? "no analysis run"
      : `${hasAnalysisResult ? "analysis result present" : "no analysis result"}, ${ranAnalysisTool ? "run_analysis called" : "run_analysis not called"}`,
  };
}

function evalNoBadModel(_assertion, state) {
  const model = state.model;
  const nodes = Array.isArray(model?.nodes) ? model.nodes : [];
  const elements = Array.isArray(model?.elements) ? model.elements : [];
  const pass = !model || (nodes.length === 0 && elements.length === 0);
  return {
    metric: "no_bad_model",
    pass,
    expected: "no computable model for unsafe or incomplete input",
    actual: model ? `${nodes.length} nodes, ${elements.length} elements` : "(none)",
  };
}

async function evalNaturalLanguage(assertion, state) {
  const result = await evaluateNaturalLanguage(assertion.description, state);
  const suffix = result.reason ? ` — ${result.reason}` : "";
  return {
    metric: "natural_language",
    pass: result.pass,
    expected: assertion.description,
    actual: result.pass ? "satisfied" : `not satisfied${suffix}`,
  };
}

function evalModelMatches(assertion, state) {
  const agentModel = state.model;
  if (!agentModel || !Array.isArray(agentModel.nodes)) {
    return {
      metric: "model_matches",
      pass: false,
      expected: "model with nodes/elements",
      actual: "(no model)",
    };
  }

  // Resolve ground truth
  const gtId = assertion.groundTruthId;
  const allGT = getGroundTruthModels();
  const gtEntry = allGT.find((m) => m.id === gtId);
  if (!gtEntry) {
    return {
      metric: "model_matches",
      pass: false,
      expected: `ground truth '${gtId}'`,
      actual: "ground truth not found",
    };
  }
  const gtModel = gtEntry.model;
  const tol = assertion.tolerances || {};
  const spanTol = tol.span ?? 0.5;   // meters
  const loadTol = tol.load ?? 0.2;   // 20%

  const agentNodes = agentModel.nodes;
  const agentElements = Array.isArray(agentModel.elements) ? agentModel.elements : [];
  const gtNodes = gtModel.nodes;
  const gtElements = Array.isArray(gtModel.elements) ? gtModel.elements : [];

  // 1. Node count
  const nodeCountOk = agentNodes.length >= gtNodes.length;

  // 2. Element count
  const elemCountOk = agentElements.length >= gtElements.length;

  function numericRange(nodes, axis) {
    const values = nodes
      .map((node) => Number(node?.[axis] ?? 0))
      .filter((value) => Number.isFinite(value));
    if (values.length === 0) return 0;
    return Math.max(...values) - Math.min(...values);
  }

  function rangeComparison(axis) {
    const actual = numericRange(agentNodes, axis);
    const expected = numericRange(gtNodes, axis);
    const diff = Math.abs(actual - expected);
    return {
      actual,
      expected,
      diff,
      ok: expected === 0 || diff <= spanTol,
    };
  }

  // 3. Geometry checks: compare coordinate ranges in X/Y/Z.
  const xRange = rangeComparison("x");
  const yRange = rangeComparison("y");
  const zRange = rangeComparison("z");

  function nodeMap(model) {
    return new Map((model.nodes || []).map((node) => [String(node.id), node]));
  }

  function elementMap(model) {
    return new Map((model.elements || []).map((element) => [String(element.id), element]));
  }

  function elementLength(element, nodesById) {
    const [startId, endId] = Array.isArray(element?.nodes) ? element.nodes : [];
    const start = nodesById.get(String(startId));
    const end = nodesById.get(String(endId));
    if (!start || !end) return 1;
    const dx = Number(end.x ?? 0) - Number(start.x ?? 0);
    const dy = Number(end.y ?? 0) - Number(start.y ?? 0);
    const dz = Number(end.z ?? 0) - Number(start.z ?? 0);
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return Number.isFinite(length) && length > 0 ? length : 1;
  }

  function sumAbsFields(record, fields) {
    return fields.reduce((sum, field) => {
      const value = Number(record?.[field]);
      return Number.isFinite(value) ? sum + Math.abs(value) : sum;
    }, 0);
  }

  function loadVectorMagnitude(load, fields) {
    const components = fields
      .map((field) => Number(load?.[field]))
      .filter((value) => Number.isFinite(value));
    if (components.length === 0) return 0;
    return components.reduce((sum, value) => sum + Math.abs(value), 0);
  }

  // 4. Load magnitude check: compare approximate total applied load.
  function totalLoad(model) {
    let sum = 0;
    const nodesById = nodeMap(model);
    const elementsById = elementMap(model);
    for (const lc of model.load_cases || []) {
      for (const load of lc.loads || []) {
        if (load.type === "distributed") {
          const intensity = loadVectorMagnitude(load, ["wx", "wy", "wz", "qx", "qy", "qz", "w", "q", "value", "magnitude"]);
          const element = elementsById.get(String(load.element));
          sum += intensity * elementLength(element, nodesById);
        } else {
          sum += sumAbsFields(load, ["fx", "fy", "fz", "px", "py", "pz", "value", "magnitude"]);
          if (Array.isArray(load.forces)) {
            sum += load.forces.reduce((acc, value) => {
              const force = Number(value);
              return Number.isFinite(force) ? acc + Math.abs(force) : acc;
            }, 0);
          }
        }
      }
    }
    return sum;
  }
  const agentLoad = totalLoad(agentModel);
  const gtLoad = totalLoad(gtModel);
  const loadRatio = gtLoad > 0 ? Math.abs(agentLoad - gtLoad) / gtLoad : 0;
  const loadOk = gtLoad === 0 || loadRatio <= loadTol;

  const allOk = nodeCountOk && elemCountOk && xRange.ok && yRange.ok && zRange.ok && loadOk;
  const details = [
    `nodes: ${agentNodes.length}/${gtNodes.length}${nodeCountOk ? " OK" : " FAIL"}`,
    `elems: ${agentElements.length}/${gtElements.length}${elemCountOk ? " OK" : " FAIL"}`,
    `x-span: ${xRange.actual.toFixed(1)}/${xRange.expected.toFixed(1)}m${xRange.ok ? " OK" : ` FAIL (Δ${xRange.diff.toFixed(2)}m)`}`,
    `y-span: ${yRange.actual.toFixed(1)}/${yRange.expected.toFixed(1)}m${yRange.ok ? " OK" : ` FAIL (Δ${yRange.diff.toFixed(2)}m)`}`,
    `height: ${zRange.actual.toFixed(1)}/${zRange.expected.toFixed(1)}m${zRange.ok ? " OK" : ` FAIL (Δ${zRange.diff.toFixed(2)}m)`}`,
    `load: ${agentLoad.toFixed(0)}/${gtLoad.toFixed(0)}kN${loadOk ? " OK" : ` FAIL (${(loadRatio * 100).toFixed(0)}%)`}`,
  ];

  return {
    metric: "model_matches",
    pass: allOk,
    expected: `match '${gtId}': nodes>=${gtNodes.length}, elems>=${gtElements.length}, x≈${xRange.expected}m±${spanTol}, y≈${yRange.expected}m±${spanTol}, z≈${zRange.expected}m±${spanTol}, load≈${gtLoad.toFixed(0)}kN±${Math.round(loadTol * 100)}%`,
    actual: details.join("; "),
  };
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

/**
 * Dispatch a single assertion to its typed evaluator.
 *
 * @param {object} assertion - v2 assertion object
 * @param {object} state - AgentState
 * @returns {Promise<{ metric: string, pass: boolean, expected: string, actual: string }>}
 */
async function dispatchAssertion(assertion, state) {
  switch (assertion.type) {
    case "structural_type":
      return evalStructuralType(assertion, state);
    case "has_model":
      return evalHasModel(assertion, state);
    case "has_analysis":
      return evalHasAnalysis(assertion, state);
    case "engine_match":
      return evalEngineMatch(assertion, state);
    case "has_report":
      return evalHasReport(assertion, state);
    case "skill_match":
      return evalSkillMatch(assertion, state);
    case "has_interaction_questions":
      return evalHasInteractionQuestions(assertion, state);
    case "should_not_analyze":
      return evalShouldNotAnalyze(assertion, state);
    case "no_bad_model":
      return evalNoBadModel(assertion, state);
    case "natural_language":
      return evalNaturalLanguage(assertion, state);
    case "model_matches":
      return evalModelMatches(assertion, state);
    default:
      return {
        metric: `unknown:${assertion.type || "undefined"}`,
        pass: false,
        expected: "valid assertion type (structural_type, has_model, has_analysis, engine_match, has_report, skill_match, has_interaction_questions, should_not_analyze, no_bad_model, natural_language, model_matches)",
        actual: `unsupported type: ${assertion.type || "(undefined)"}`,
      };
  }
}

/**
 * Evaluate a completed AgentState against a scenario's expectations.
 *
 * @param {object} scenario - benchmark scenario (v1 or v2 format)
 * @param {object} state - AgentState returned by service.runFull
 * @param {number} durationMs - elapsed time in milliseconds
 * @returns {Promise<object>} evaluation result
 */
async function evaluateScenario(scenario, state, durationMs) {
  const metrics = [];
  const { assertions } = upgradeExpect(scenario.expect || {});

  for (const assertion of assertions) {
    try {
      metrics.push(await dispatchAssertion(assertion, state));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      metrics.push({
        metric: assertion.type || "unknown",
        pass: false,
        expected: "(assertion ran without error)",
        actual: `error: ${msg}`,
      });
    }
  }

  // Tool call count (informational — always measured)
  let toolCallCount = 0;
  const messages = Array.isArray(state.messages) ? state.messages : [];
  for (const msg of messages) {
    if (msg && typeof msg === "object" && Array.isArray(msg.tool_calls)) {
      toolCallCount += msg.tool_calls.length;
    }
  }
  metrics.push({
    metric: "toolCalls",
    pass: true,
    expected: "(info, lower is better)",
    actual: String(toolCallCount),
  });

  // Duration (informational, always pass)
  metrics.push({
    metric: "duration",
    pass: true,
    expected: "(info)",
    actual: `${(durationMs / 1000).toFixed(1)}s`,
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
    analysisSkillTarget: scenario.analysisSkillTarget || null,
    analysisEngineTarget: scenario.analysisEngineTarget || null,
    mode: scenario.mode || "auto",
    evaluationFocus: Array.isArray(scenario.evaluationFocus) ? scenario.evaluationFocus : [],
    passed: metrics.filter((m) => m.pass).length,
    total: metrics.length,
    allPassed: metrics.every((m) => m.pass),
    metrics,
    durationMs,
  };
}

module.exports = { evaluateScenario };
