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

const STRUCTURAL_TYPE_ALIASES = {
  frame: ["frame", "steel-frame", "concrete-frame", "portal-frame"],
  "portal-frame": ["portal-frame", "portal"],
};

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
  const allowed = [
    assertion.expected,
    ...(Array.isArray(assertion.accept) ? assertion.accept : []),
    ...(STRUCTURAL_TYPE_ALIASES[assertion.expected] || []),
  ].filter(Boolean);
  const uniqueAllowed = [...new Set(allowed)];
  return {
    metric: "structural_type",
    pass: actual !== null && uniqueAllowed.includes(actual),
    expected: uniqueAllowed.length > 1 ? uniqueAllowed.join(" or ") : assertion.expected,
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
  const draft = asRecord(state.draftState);
  const actual = trace?.skillId || firstString(draft?.skillId, draft?.inferredType);
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

function messageContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item?.type === "text") return item.text || "";
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasPendingClarificationFromToolResult(state) {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  return messages.some((msg) => {
    if (msg?.name !== "extract_draft_params") return false;
    const content = parseJsonObject(msg.content);
    if (!content) return false;
    const questions = Array.isArray(content.clarificationQuestions)
      ? content.clarificationQuestions
      : [];
    if (questions.some((question) => typeof question?.question === "string" && question.question.trim())) {
      return true;
    }
    return (
      content.nextAction === "ask_user_clarification"
      && Array.isArray(content.criticalMissing)
      && content.criticalMissing.length > 0
    );
  });
}

function assistantTextLooksLikeQuestion(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  const lower = value.toLowerCase();
  const mentionsMissingInput =
    lower.includes("information")
    || lower.includes("details")
    || lower.includes("structural type")
    || lower.includes("geometry")
    || lower.includes("dimension")
    || lower.includes("load")
    || lower.includes("boundary")
    || lower.includes("material");
  return (
    /[?？]/.test(value)
    || lower.includes("please provide")
    || lower.includes("please specify")
    || lower.includes("need more information")
    || lower.includes("insufficient information")
    || lower.includes("insufficient input")
    || lower.includes("not enough information")
    || lower.includes("missing information")
    || lower.includes("missing parameters")
    || lower.includes("incomplete information")
    || lower.includes("incomplete parameters")
    || ((lower.includes("i need") || lower.includes("we need") || lower.includes("need to know")) && mentionsMissingInput)
    || ((lower.includes("cannot") || lower.includes("can't")) && mentionsMissingInput)
    || lower.includes("cannot build")
    || lower.includes("cannot create")
    || lower.includes("cannot generate")
    || lower.includes("could you")
    || lower.includes("clarify")
    || lower.includes("cannot proceed")
    || value.includes("请提供")
    || value.includes("请补充")
    || value.includes("请确认")
    || value.includes("请说明")
    || value.includes("请明确")
    || value.includes("请告知")
    || value.includes("请重新给出")
    || value.includes("重新给出")
    || value.includes("需要更多")
    || value.includes("需要补充")
    || value.includes("需要明确")
    || value.includes("信息不足")
    || value.includes("资料不足")
    || value.includes("参数不足")
    || value.includes("参数不完整")
    || value.includes("信息不完整")
    || value.includes("不足以")
    || value.includes("缺少")
    || value.includes("无法继续")
    || value.includes("无法直接")
    || value.includes("无法分析")
    || value.includes("无法建立")
    || value.includes("无法生成")
    || value.includes("不能直接")
  );
}

function hasInteractionQuestions(state) {
  if (hasPendingClarificationFromToolResult(state)) return true;
  const messages = Array.isArray(state.messages) ? state.messages : [];
  return messages.some((msg) => {
    if (msg.type !== "ai" && msg.role !== "assistant") return false;
    if (Array.isArray(msg.tool_calls)) {
      return msg.tool_calls.some(
        (tc) => tc.name === "ask_user_clarification",
      );
    }
    return assistantTextLooksLikeQuestion(messageContentText(msg.content));
  });
}

function evalHasInteractionQuestions(_assertion, state) {
  const hasQuestions = hasInteractionQuestions(state);
  return {
    metric: "has_interaction_questions",
    pass: hasQuestions,
    expected: "agent asks user for missing parameters",
    actual: hasQuestions ? "questions found" : "no questions asked",
  };
}

function expectedTextRequestsInteraction(text) {
  const value = String(text || "").toLowerCase();
  return (
    value.includes("ask")
    || value.includes("clarify")
    || value.includes("missing")
    || value.includes("incomplete")
    || value.includes("缺")
    || value.includes("澄清")
    || value.includes("追问")
    || value.includes("补充")
    || value.includes("明确")
  );
}

function reconcileSemanticInteraction(metrics) {
  const semanticInteraction = metrics.some((metric) => (
    metric.metric === "natural_language"
    && metric.pass
    && expectedTextRequestsInteraction(metric.expected)
  ));
  if (!semanticInteraction) return metrics;
  return metrics.map((metric) => {
    if (metric.metric !== "has_interaction_questions" || metric.pass) return metric;
    return {
      ...metric,
      pass: true,
      actual: "semantic interaction satisfied by judge",
    };
  });
}

function evalAnalysisOrInteraction(_assertion, state) {
  const interaction = hasInteractionQuestions(state);
  const analysis = evalHasAnalysis(_assertion, state).pass;
  return {
    metric: "analysis_or_interaction",
    pass: interaction || analysis,
    expected: "agent asks for clarification or completes analysis",
    actual: [
      interaction ? "questions found" : "no questions",
      analysis ? "analysis present" : "no analysis",
    ].join(", "),
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
    const [startId, endId] = Array.isArray(element?.nodes)
      ? element.nodes
      : Array.isArray(element?.nodeIds)
        ? element.nodeIds
        : [];
    const start = nodesById.get(String(startId));
    const end = nodesById.get(String(endId));
    if (!start || !end) return 1;
    const dx = Number(end.x ?? 0) - Number(start.x ?? 0);
    const dy = Number(end.y ?? 0) - Number(start.y ?? 0);
    const dz = Number(end.z ?? 0) - Number(start.z ?? 0);
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return Number.isFinite(length) && length > 0 ? length : 1;
  }

  function toFiniteNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length === 0) return null;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function firstUnit(record) {
    for (const field of ["unit", "forceUnit", "force_unit", "units"]) {
      const value = record?.[field];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return "";
  }

  function unitScaleToKN(record) {
    const normalized = firstUnit(record).toLowerCase().replace(/\s+/g, "");
    if (["n", "n/m", "npermeter", "n/m2", "n/m^2", "npermeter2"].includes(normalized)) {
      return 1 / 1000;
    }
    return 1;
  }

  function sumAbsFields(record, fields) {
    const scale = unitScaleToKN(record);
    return fields.reduce((sum, field) => {
      const value = toFiniteNumber(record?.[field]);
      return Number.isFinite(value) ? sum + Math.abs(value) : sum;
    }, 0) * scale;
  }

  function loadVectorMagnitude(load, fields) {
    const scale = unitScaleToKN(load);
    const components = fields
      .map((field) => toFiniteNumber(load?.[field]))
      .filter((value) => value !== null);
    if (components.length === 0) return 0;
    return components.reduce((sum, value) => sum + Math.abs(value), 0) * scale;
  }

  function isDistributedLoad(load) {
    const type = String(load?.type || "").toLowerCase();
    return type === "distributed"
      || type === "line_load"
      || type === "element_uniform_load"
      || type === "uniform_load"
      || load?.element !== undefined
      || load?.elementId !== undefined
      || load?.element_id !== undefined;
  }

  function loadElementId(load) {
    return load?.element ?? load?.elementId ?? load?.element_id;
  }

  function loadCaseHasLoads(loadCase) {
    return Array.isArray(loadCase?.loads) && loadCase.loads.length > 0;
  }

  function isGravityLoadCase(loadCase) {
    const id = String(loadCase?.id || loadCase?.name || "").toLowerCase();
    const type = String(loadCase?.type || "").toLowerCase();
    return ["d", "dead", "l", "live", "lc1"].includes(id) || ["dead", "live", "gravity"].includes(type);
  }

  function hasExplicitGravityLoads(model) {
    return (model.load_cases || []).some((loadCase) => isGravityLoadCase(loadCase) && loadCaseHasLoads(loadCase));
  }

  function floorLoadValue(entry) {
    if (!entry || typeof entry !== "object") return 0;
    const value = toFiniteNumber(entry.value ?? entry.load ?? entry.magnitude ?? entry.floorLoad);
    return value === null ? 0 : Math.abs(value) * unitScaleToKN(entry);
  }

  function storyFloorLoadIntensity(story) {
    const floorLoads = Array.isArray(story?.floor_loads) ? story.floor_loads : [];
    if (floorLoads.length > 0) {
      return floorLoads.reduce((sum, entry) => sum + floorLoadValue(entry), 0);
    }
    return ["dead_load", "live_load", "floorLoad", "floor_load"]
      .reduce((sum, field) => {
        const value = toFiniteNumber(story?.[field]);
        return value === null ? sum : sum + Math.abs(value) * unitScaleToKN(story);
      }, 0);
  }

  function floorMeasure(model) {
    const x = numericRange(model.nodes || [], "x");
    const y = numericRange(model.nodes || [], "y");
    if (x <= 0) return 1;
    return y > 0 ? x * y : x;
  }

  function totalStoryFloorLoad(model) {
    const stories = Array.isArray(model?.stories) ? model.stories : [];
    if (stories.length === 0) return 0;
    const measure = floorMeasure(model);
    return stories.reduce((sum, story) => sum + storyFloorLoadIntensity(story) * measure, 0);
  }

  // 4. Load magnitude check: compare approximate total applied load.
  function totalExplicitLoad(model) {
    let sum = 0;
    const nodesById = nodeMap(model);
    const elementsById = elementMap(model);
    for (const lc of model.load_cases || []) {
      for (const load of lc.loads || []) {
        if (isDistributedLoad(load)) {
          const intensity = loadVectorMagnitude(load, ["wx", "wy", "wz", "qx", "qy", "qz", "w", "q", "value", "magnitude"]);
          const element = elementsById.get(String(loadElementId(load)));
          sum += intensity * elementLength(element, nodesById);
        } else {
          sum += sumAbsFields(load, ["fx", "fy", "fz", "px", "py", "pz", "value", "magnitude"]);
          if (Array.isArray(load.forces)) {
            const scale = unitScaleToKN(load);
            sum += load.forces.reduce((acc, value) => {
              const force = toFiniteNumber(value);
              return force !== null ? acc + Math.abs(force) * scale : acc;
            }, 0);
          }
        }
      }
    }
    return sum;
  }

  function loadDirection(load) {
    for (const field of ["axis", "direction", "globalAxis", "global_axis"]) {
      const value = load?.[field];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim().toLowerCase();
      }
    }
    return "";
  }

  function vectorArrayComponent(load, axis) {
    if (!Array.isArray(load?.forces)) return 0;
    const axisIndex = { x: 0, y: 1, z: 2 }[axis];
    const force = toFiniteNumber(load.forces[axisIndex]);
    return force === null ? 0 : Math.abs(force) * unitScaleToKN(load);
  }

  function componentFields(axis, distributed) {
    const pointFields = {
      x: ["fx", "px"],
      y: ["fy", "py"],
      z: ["fz", "pz"],
    };
    const distributedFields = {
      x: ["wx", "qx"],
      y: ["wy", "qy"],
      z: ["wz", "qz", "w", "q"],
    };
    return distributed ? distributedFields[axis] || [] : pointFields[axis] || [];
  }

  function directionalScalar(load, axis) {
    const direction = loadDirection(load);
    if (direction !== axis && direction !== `global_${axis}` && direction !== `${axis}-axis`) {
      return 0;
    }
    return sumAbsFields(load, ["value", "magnitude", "load", "force"]);
  }

  function loadComponentMagnitude(load, axis, distributed) {
    return sumAbsFields(load, componentFields(axis, distributed))
      + directionalScalar(load, axis)
      + (distributed ? 0 : vectorArrayComponent(load, axis));
  }

  function totalExplicitLoadByAxis(model, axis) {
    let sum = 0;
    const nodesById = nodeMap(model);
    const elementsById = elementMap(model);
    for (const lc of model.load_cases || []) {
      for (const load of lc.loads || []) {
        if (isDistributedLoad(load)) {
          const intensity = loadComponentMagnitude(load, axis, true);
          const element = elementsById.get(String(loadElementId(load)));
          sum += intensity * elementLength(element, nodesById);
        } else {
          sum += loadComponentMagnitude(load, axis, false);
        }
      }
    }
    return sum;
  }

  function totalLoad(model) {
    const explicit = totalExplicitLoad(model);
    const story = totalStoryFloorLoad(model);
    if (story > 0 && !hasExplicitGravityLoads(model)) {
      return { value: explicit + story, source: explicit > 0 ? "load_cases+stories" : "stories" };
    }
    return { value: explicit, source: "load_cases" };
  }

  function totalLoadByAxis(model, axis) {
    const explicit = totalExplicitLoadByAxis(model, axis);
    const story = axis === "z" ? totalStoryFloorLoad(model) : 0;
    if (story > 0 && !hasExplicitGravityLoads(model)) {
      return { value: explicit + story, source: explicit > 0 ? "load_cases+stories" : "stories" };
    }
    return { value: explicit, source: "load_cases" };
  }

  function normalizeComparableLoad(actual, expected) {
    if (expected <= 0 || actual <= 0) return { value: actual, note: "" };
    const directRatio = Math.abs(actual - expected) / expected;
    const nToKN = actual / 1000;
    const scaledRatio = Math.abs(nToKN - expected) / expected;
    if (directRatio > loadTol && scaledRatio <= loadTol) {
      return { value: nToKN, note: " (normalized N→kN)" };
    }
    return { value: actual, note: "" };
  }

  const loadAxes = Array.isArray(assertion.loadAxes)
    ? assertion.loadAxes.map((axis) => String(axis).toLowerCase()).filter((axis) => ["x", "y", "z"].includes(axis))
    : [];

  const loadComparisons = loadAxes.length > 0
    ? loadAxes.map((axis) => {
        const agentLoadRaw = totalLoadByAxis(agentModel, axis);
        const gtLoadRaw = totalLoadByAxis(gtModel, axis);
        const gtLoad = gtLoadRaw.value;
        const normalizedAgentLoad = normalizeComparableLoad(agentLoadRaw.value, gtLoad);
        const agentLoad = normalizedAgentLoad.value;
        const ratio = gtLoad > 0 ? Math.abs(agentLoad - gtLoad) / gtLoad : 0;
        return {
          label: `load-${axis}`,
          agentLoad,
          gtLoad,
          ratio,
          ok: gtLoad === 0 || ratio <= loadTol,
          note: normalizedAgentLoad.note,
          agentSource: agentLoadRaw.source,
          gtSource: gtLoadRaw.source,
        };
      })
    : (() => {
        const agentLoadRaw = totalLoad(agentModel);
        const gtLoadRaw = totalLoad(gtModel);
        const gtLoad = gtLoadRaw.value;
        const normalizedAgentLoad = normalizeComparableLoad(agentLoadRaw.value, gtLoad);
        const agentLoad = normalizedAgentLoad.value;
        const ratio = gtLoad > 0 ? Math.abs(agentLoad - gtLoad) / gtLoad : 0;
        return [{
          label: "load",
          agentLoad,
          gtLoad,
          ratio,
          ok: gtLoad === 0 || ratio <= loadTol,
          note: normalizedAgentLoad.note,
          agentSource: agentLoadRaw.source,
          gtSource: gtLoadRaw.source,
        }];
      })();

  const loadOk = loadComparisons.every((comparison) => comparison.ok);

  const allOk = nodeCountOk && elemCountOk && xRange.ok && yRange.ok && zRange.ok && loadOk;
  const details = [
    `nodes: ${agentNodes.length}/${gtNodes.length}${nodeCountOk ? " OK" : " FAIL"}`,
    `elems: ${agentElements.length}/${gtElements.length}${elemCountOk ? " OK" : " FAIL"}`,
    `x-span: ${xRange.actual.toFixed(1)}/${xRange.expected.toFixed(1)}m${xRange.ok ? " OK" : ` FAIL (Δ${xRange.diff.toFixed(2)}m)`}`,
    `y-span: ${yRange.actual.toFixed(1)}/${yRange.expected.toFixed(1)}m${yRange.ok ? " OK" : ` FAIL (Δ${yRange.diff.toFixed(2)}m)`}`,
    `height: ${zRange.actual.toFixed(1)}/${zRange.expected.toFixed(1)}m${zRange.ok ? " OK" : ` FAIL (Δ${zRange.diff.toFixed(2)}m)`}`,
  ];
  for (const comparison of loadComparisons) {
    details.push(
      `${comparison.label}: ${comparison.agentLoad.toFixed(0)}/${comparison.gtLoad.toFixed(0)}kN${comparison.note} [agent:${comparison.agentSource}, gt:${comparison.gtSource}]${comparison.ok ? " OK" : ` FAIL (${(comparison.ratio * 100).toFixed(0)}%)`}`,
    );
  }

  const expectedParts = [
    `match '${gtId}': nodes>=${gtNodes.length}`,
    `elems>=${gtElements.length}`,
    `x≈${xRange.expected}m±${spanTol}`,
    `y≈${yRange.expected}m±${spanTol}`,
    `z≈${zRange.expected}m±${spanTol}`,
  ];
  for (const comparison of loadComparisons) {
    expectedParts.push(`${comparison.label}≈${comparison.gtLoad.toFixed(0)}kN±${Math.round(loadTol * 100)}%`);
  }

  return {
    metric: "model_matches",
    pass: allOk,
    expected: expectedParts.join(", "),
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
    case "analysis_or_interaction":
      return evalAnalysisOrInteraction(assertion, state);
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
        expected: "valid assertion type (structural_type, has_model, has_analysis, engine_match, has_report, skill_match, has_interaction_questions, analysis_or_interaction, should_not_analyze, no_bad_model, natural_language, model_matches)",
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

  const reconciledMetrics = reconcileSemanticInteraction(metrics);

  // Tool call count (informational — always measured)
  let toolCallCount = 0;
  const messages = Array.isArray(state.messages) ? state.messages : [];
  for (const msg of messages) {
    if (msg && typeof msg === "object" && Array.isArray(msg.tool_calls)) {
      toolCallCount += msg.tool_calls.length;
    }
  }
  reconciledMetrics.push({
    metric: "toolCalls",
    pass: true,
    expected: "(info, lower is better)",
    actual: String(toolCallCount),
  });

  // Duration (informational, always pass)
  reconciledMetrics.push({
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
    category: scenario.category || null,
    tags: Array.isArray(scenario.tags) ? scenario.tags : [],
    locale: scenario.locale || null,
    analysisSkillTarget: scenario.analysisSkillTarget || null,
    analysisEngineTarget: scenario.analysisEngineTarget || null,
    mode: scenario.mode || "auto",
    evaluationFocus: Array.isArray(scenario.evaluationFocus) ? scenario.evaluationFocus : [],
    passed: reconciledMetrics.filter((m) => m.pass).length,
    total: reconciledMetrics.length,
    allPassed: reconciledMetrics.every((m) => m.pass),
    metrics: reconciledMetrics,
    durationMs,
  };
}

module.exports = { evaluateScenario };
