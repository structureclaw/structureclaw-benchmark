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
  const agentElements = agentModel.elements;
  const gtNodes = gtModel.nodes;
  const gtElements = gtModel.elements;

  // 1. Node count
  const nodeCountOk = agentNodes.length >= gtNodes.length;

  // 2. Element count
  const elemCountOk = agentElements.length >= gtElements.length;

  // 3. Span check: compare the range of x-coordinates
  const agentXs = agentNodes.map((n) => n.x);
  const gtXs = gtNodes.map((n) => n.x);
  const agentSpan = Math.max(...agentXs) - Math.min(...agentXs);
  const gtSpan = Math.max(...gtXs) - Math.min(...gtXs);
  const spanDiff = Math.abs(agentSpan - gtSpan);
  const spanOk = gtSpan === 0 || spanDiff <= spanTol;

  // 4. Height check: compare the range of z-coordinates
  const agentZs = agentNodes.map((n) => n.z);
  const gtZs = gtNodes.map((n) => n.z);
  const agentH = Math.max(...agentZs) - Math.min(...agentZs);
  const gtH = Math.max(...gtZs) - Math.min(...gtZs);
  const heightDiff = Math.abs(agentH - gtH);
  const heightOk = gtH === 0 || heightDiff <= spanTol;

  // 5. Load magnitude check: compare total load
  function totalLoad(model) {
    let sum = 0;
    for (const lc of model.load_cases || []) {
      for (const load of lc.loads || []) {
        if (load.type === "distributed") sum += Math.abs(load.wz || 0) * 1; // per unit length
        else if (load.fz) sum += Math.abs(load.fz);
        else if (load.forces) sum += Math.abs(load.forces[2] || 0);
        else if (load.fx) sum += Math.abs(load.fx);
      }
    }
    return sum;
  }
  const agentLoad = totalLoad(agentModel);
  const gtLoad = totalLoad(gtModel);
  const loadRatio = gtLoad > 0 ? Math.abs(agentLoad - gtLoad) / gtLoad : 0;
  const loadOk = gtLoad === 0 || loadRatio <= loadTol;

  const allOk = nodeCountOk && elemCountOk && spanOk && heightOk && loadOk;
  const details = [
    `nodes: ${agentNodes.length}/${gtNodes.length}${nodeCountOk ? " OK" : " FAIL"}`,
    `elems: ${agentElements.length}/${gtElements.length}${elemCountOk ? " OK" : " FAIL"}`,
    `span: ${agentSpan.toFixed(1)}/${gtSpan.toFixed(1)}m${spanOk ? " OK" : ` FAIL (Δ${spanDiff.toFixed(2)}m)`}`,
    `height: ${agentH.toFixed(1)}/${gtH.toFixed(1)}m${heightOk ? " OK" : ` FAIL (Δ${heightDiff.toFixed(2)}m)`}`,
    `load: ${agentLoad.toFixed(0)}/${gtLoad.toFixed(0)}kN${loadOk ? " OK" : ` FAIL (${(loadRatio * 100).toFixed(0)}%)`}`,
  ];

  return {
    metric: "model_matches",
    pass: allOk,
    expected: `match '${gtId}': nodes>=${gtNodes.length}, elems>=${gtElements.length}, span≈${gtSpan}m±${spanTol}, load≈${gtLoad}kN±${Math.round(loadTol * 100)}%`,
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
    case "has_report":
      return evalHasReport(assertion, state);
    case "skill_match":
      return evalSkillMatch(assertion, state);
    case "has_interaction_questions":
      return evalHasInteractionQuestions(assertion, state);
    case "natural_language":
      return evalNaturalLanguage(assertion, state);
    case "model_matches":
      return evalModelMatches(assertion, state);
    default:
      return {
        metric: `unknown:${assertion.type || "undefined"}`,
        pass: false,
        expected: "valid assertion type (structural_type, has_model, has_analysis, has_report, skill_match, has_interaction_questions, natural_language, model_matches)",
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
    pass: toolCallCount <= 15,
    expected: "<= 15",
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
    description: scenario.description || "",
    passed: metrics.filter((m) => m.pass).length,
    total: metrics.length,
    allPassed: metrics.every((m) => m.pass),
    metrics,
    durationMs,
  };
}

module.exports = { evaluateScenario };
