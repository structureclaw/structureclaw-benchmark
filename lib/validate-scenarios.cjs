const fs = require("node:fs");
const path = require("node:path");

const BENCH_ROOT = path.resolve(__dirname, "..");
const SCENARIOS_DIR = path.join(BENCH_ROOT, "scenarios");
const GROUND_TRUTH_FILE = path.join(BENCH_ROOT, "fixtures", "ground-truth-models.json");

const TASK_FAMILIES = {
  standard_workflow: { count: 50, split: "core" },
  interactive_robustness: { count: 50, split: "core" },
  multimodal_reverse_engineering: { count: 50, split: "auxiliary" },
};

const SCENARIO_MAX_RETRIES = 0;

const REQUIRED_FIELDS = [
  "id",
  "split",
  "taskFamily",
  "inputModality",
  "structureType",
  "benchmarkStructureType",
  "difficulty",
  "skillTarget",
  "locale",
  "evaluationFocus",
];

const EVALUATION_FOCUS = new Set([
  "routing",
  "modeling",
  "model_match",
  "analysis",
  "engine_match",
  "interaction",
  "report",
  "semantic",
]);

const ANALYSIS_SKILL_ENGINE_IDS = {
  "opensees-static": "builtin-opensees",
  "pkpm-static": "builtin-pkpm",
  "yjk-static": "builtin-yjk",
};

const ALLOWED_STRUCTURAL_TYPE_PAIRS = new Set([
  "concrete-frame/frame",
]);

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

function collectJsonFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectJsonFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith(".json")) return [fullPath];
    return [];
  });
}

function rel(file) {
  return path.relative(BENCH_ROOT, file).replace(/\\/g, "/");
}

function collectAttachments(scenario) {
  const attachments = [];
  if (Array.isArray(scenario.attachments)) attachments.push(...scenario.attachments);
  if (Array.isArray(scenario.turns)) {
    for (const turn of scenario.turns) {
      if (Array.isArray(turn.attachments)) attachments.push(...turn.attachments);
    }
  }
  return attachments;
}

function resolveAttachment(relPath) {
  if (path.isAbsolute(relPath)) return relPath;
  const normalized = relPath.replace(/^tests[\\/]+llm-benchmark[\\/]+/, "");
  return path.resolve(BENCH_ROOT, normalized);
}

function scenarioPromptText(scenario) {
  if (typeof scenario.message === "string") return scenario.message;
  if (Array.isArray(scenario.turns)) {
    return scenario.turns.map((turn) => turn.message || "").join(" | ");
  }
  return "";
}

function normalizePromptSignature(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\d.]+\s*(m|米|kn\/m2|kn\/m²|kn\/m|kn|mm|t|层|跨|story|bay|bays|panel|panels|节间)/g, "#")
    .replace(/[，。,.、;；:：()（）\s]+/g, " ")
    .trim();
}

function hasCjk(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function validate() {
  const errors = [];
  const groundTruthModels = new Map(
    JSON.parse(fs.readFileSync(GROUND_TRUTH_FILE, "utf-8")).map((item) => [item.id, item]),
  );
  const files = collectJsonFiles(SCENARIOS_DIR);
  const ids = new Map();
  const promptSignatures = new Map();
  const familyCounts = Object.fromEntries(Object.keys(TASK_FAMILIES).map((family) => [family, 0]));
  const familyLocaleCounts = Object.fromEntries(
    Object.keys(TASK_FAMILIES).flatMap((family) => [[`${family}/zh`, 0], [`${family}/en`, 0]]),
  );
  const splitCounts = { core: 0, auxiliary: 0 };

  for (const file of files) {
    const relative = rel(file);
    const parts = relative.replace(/^scenarios\//, "").split("/");
    if (parts.length !== 2) {
      errors.push(`${relative}: scenarios must live directly under scenarios/<taskFamily>/<id>.json`);
      continue;
    }

    const [familyDir, fileName] = parts;
    if (!TASK_FAMILIES[familyDir]) {
      errors.push(`${relative}: unknown task family directory "${familyDir}"`);
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (error) {
      errors.push(`${relative}: invalid JSON (${error.message})`);
      continue;
    }

    if (Array.isArray(parsed) || !parsed || typeof parsed !== "object") {
      errors.push(`${relative}: expected one scenario object, not an array or primitive`);
      continue;
    }

    const scenario = parsed;
    for (const field of REQUIRED_FIELDS) {
      if (scenario[field] === undefined || scenario[field] === null) {
        errors.push(`${relative}: missing required field "${field}"`);
      }
    }

    if (scenario.maxRetries !== SCENARIO_MAX_RETRIES) {
      errors.push(`${relative}: maxRetries must be ${SCENARIO_MAX_RETRIES}`);
    }

    const expectedFileName = `${scenario.id}.json`;
    if (fileName !== expectedFileName) {
      errors.push(`${relative}: file name must match id (${expectedFileName})`);
    }

    if (ids.has(scenario.id)) {
      errors.push(`${relative}: duplicate scenario id "${scenario.id}" also found in ${ids.get(scenario.id)}`);
    } else if (scenario.id) {
      ids.set(scenario.id, relative);
    }

    if (scenario.taskFamily !== familyDir) {
      errors.push(`${relative}: taskFamily "${scenario.taskFamily}" does not match directory "${familyDir}"`);
    }

    const expectedBenchmarkType = BENCHMARK_STRUCTURE_TYPE[scenario.structureType] || scenario.structureType;
    if (scenario.benchmarkStructureType !== expectedBenchmarkType) {
      errors.push(
        `${relative}: benchmarkStructureType must be "${expectedBenchmarkType}" for structureType "${scenario.structureType}"`,
      );
    }

    const expectedSplit = TASK_FAMILIES[familyDir].split;
    if (scenario.split !== expectedSplit) {
      errors.push(`${relative}: split must be "${expectedSplit}" for ${familyDir}`);
    }

    familyCounts[familyDir] += 1;
    if (scenario.locale === "zh" || scenario.locale === "en") {
      familyLocaleCounts[`${familyDir}/${scenario.locale}`] += 1;
    } else {
      errors.push(`${relative}: locale must be "zh" or "en"`);
    }
    if (scenario.split) splitCounts[scenario.split] = (splitCounts[scenario.split] || 0) + 1;

    if (scenario.locale === "en") {
      const userText = [
        scenario.description || "",
        scenario.message || "",
        ...(Array.isArray(scenario.turns) ? scenario.turns.map((turn) => turn.message || "") : []),
      ].join(" ");
      if (hasCjk(userText)) {
        errors.push(`${relative}: English-locale description/message must not contain CJK text`);
      }
      if (Array.isArray(scenario.tags)) {
        if (scenario.tags.includes("zh")) errors.push(`${relative}: English-locale scenario must not have a "zh" tag`);
        if (!scenario.tags.includes("en")) errors.push(`${relative}: English-locale scenario must have an "en" tag`);
      }
    }

    const promptSignature = [
      scenario.taskFamily,
      scenario.benchmarkStructureType,
      scenario.inputModality,
      normalizePromptSignature(scenarioPromptText(scenario)),
    ].join("::");
    if (promptSignatures.has(promptSignature)) {
      errors.push(
        `${relative}: duplicate normalized prompt signature also found in ${promptSignatures.get(promptSignature)}`,
      );
    } else {
      promptSignatures.set(promptSignature, relative);
    }

    if (!Array.isArray(scenario.evaluationFocus) || scenario.evaluationFocus.length === 0) {
      errors.push(`${relative}: evaluationFocus must be a non-empty array`);
    } else {
      for (const focus of scenario.evaluationFocus) {
        if (!EVALUATION_FOCUS.has(focus)) {
          errors.push(`${relative}: unknown evaluationFocus "${focus}"`);
        }
      }
    }

    const hasMessage = typeof scenario.message === "string" && scenario.message.trim().length > 0;
    const hasTurns = Array.isArray(scenario.turns) && scenario.turns.length > 0;
    if (!hasMessage && !hasTurns) {
      errors.push(`${relative}: scenario must define message or turns`);
    }

    const assertions = [
      ...(Array.isArray(scenario.expect?.assertions) ? scenario.expect.assertions : []),
      ...(Array.isArray(scenario.turns)
        ? scenario.turns.flatMap((turn) => Array.isArray(turn.assertions) ? turn.assertions : [])
        : []),
    ];
    if (assertions.length === 0) {
      errors.push(`${relative}: scenario must define at least one assertion`);
    }

    const assertionTypes = assertions.map((assertion) => assertion.type);
    const focus = new Set(Array.isArray(scenario.evaluationFocus) ? scenario.evaluationFocus : []);
    const expectedEngineId = scenario.analysisEngineTarget || (
      scenario.analysisSkillTarget ? ANALYSIS_SKILL_ENGINE_IDS[scenario.analysisSkillTarget] : undefined
    );

    if (scenario.analysisSkillTarget !== undefined && !ANALYSIS_SKILL_ENGINE_IDS[scenario.analysisSkillTarget]) {
      errors.push(`${relative}: unknown analysisSkillTarget "${scenario.analysisSkillTarget}"`);
    }
    if (scenario.analysisEngineTarget !== undefined) {
      if (!Object.values(ANALYSIS_SKILL_ENGINE_IDS).includes(scenario.analysisEngineTarget)) {
        errors.push(`${relative}: unknown analysisEngineTarget "${scenario.analysisEngineTarget}"`);
      }
      if (scenario.analysisSkillTarget && scenario.analysisEngineTarget !== ANALYSIS_SKILL_ENGINE_IDS[scenario.analysisSkillTarget]) {
        errors.push(
          `${relative}: analysisEngineTarget "${scenario.analysisEngineTarget}" does not match ` +
          `analysisSkillTarget "${scenario.analysisSkillTarget}"`,
        );
      }
    }

    for (const assertion of assertions) {
      if (assertion.type === "skill_match" && assertion.primary !== scenario.skillTarget) {
        errors.push(
          `${relative}: skill_match primary "${assertion.primary}" must match skillTarget "${scenario.skillTarget}"`,
        );
      }
      if (assertion.type === "structural_type" && assertion.expected !== scenario.structureType) {
        const pair = `${scenario.structureType}/${assertion.expected}`;
        if (!ALLOWED_STRUCTURAL_TYPE_PAIRS.has(pair)) {
          errors.push(
            `${relative}: structural_type expected "${assertion.expected}" must match structureType "${scenario.structureType}"`,
          );
        }
      }
      if (assertion.type === "model_matches") {
        const groundTruth = groundTruthModels.get(assertion.groundTruthId);
        if (!groundTruth) {
          errors.push(`${relative}: unknown groundTruthId "${assertion.groundTruthId}"`);
        } else {
          const pair = `${scenario.structureType}/${groundTruth.inferredType}`;
          if (scenario.structureType !== groundTruth.inferredType && !ALLOWED_STRUCTURAL_TYPE_PAIRS.has(pair)) {
            errors.push(
              `${relative}: groundTruth "${assertion.groundTruthId}" type "${groundTruth.inferredType}" ` +
              `must match structureType "${scenario.structureType}"`,
            );
          }
        }
      }
      if ((assertion.type === "has_model" || assertion.type === "model_matches") && !focus.has("modeling")) {
        errors.push(`${relative}: ${assertion.type} assertion requires "modeling" evaluationFocus`);
      }
      if (assertion.type === "model_matches" && !focus.has("model_match")) {
        errors.push(`${relative}: model_matches assertion requires "model_match" evaluationFocus`);
      }
      if (assertion.type === "has_analysis" && !focus.has("analysis")) {
        errors.push(`${relative}: has_analysis assertion requires "analysis" evaluationFocus`);
      }
      if (assertion.type === "engine_match") {
        if (!focus.has("engine_match")) {
          errors.push(`${relative}: engine_match assertion requires "engine_match" evaluationFocus`);
        }
        if (!focus.has("analysis")) {
          errors.push(`${relative}: engine_match assertion requires "analysis" evaluationFocus`);
        }
        if (expectedEngineId && assertion.expected !== expectedEngineId) {
          errors.push(
            `${relative}: engine_match expected "${assertion.expected}" must match analysis target "${expectedEngineId}"`,
          );
        }
        if (assertion.skillId && scenario.analysisSkillTarget && assertion.skillId !== scenario.analysisSkillTarget) {
          errors.push(
            `${relative}: engine_match skillId "${assertion.skillId}" must match analysisSkillTarget ` +
            `"${scenario.analysisSkillTarget}"`,
          );
        }
      }
      if (assertion.type === "has_interaction_questions" && !focus.has("interaction")) {
        errors.push(`${relative}: has_interaction_questions assertion requires "interaction" evaluationFocus`);
      }
      if (assertion.type === "has_report" && !focus.has("report")) {
        errors.push(`${relative}: has_report assertion requires "report" evaluationFocus`);
      }
    }
    if (focus.has("model_match") && !assertionTypes.includes("model_matches")) {
      errors.push(`${relative}: "model_match" evaluationFocus requires a model_matches assertion`);
    }
    if (focus.has("report") && !assertionTypes.includes("has_report")) {
      errors.push(`${relative}: "report" evaluationFocus requires a has_report assertion`);
    }
    if (focus.has("engine_match") && !assertionTypes.includes("engine_match")) {
      errors.push(`${relative}: "engine_match" evaluationFocus requires an engine_match assertion`);
    }

    for (const attachment of collectAttachments(scenario)) {
      if (!attachment.relPath) {
        errors.push(`${relative}: attachment is missing relPath`);
        continue;
      }
      const attachmentPath = resolveAttachment(attachment.relPath);
      if (!fs.existsSync(attachmentPath)) {
        errors.push(`${relative}: attachment does not exist (${attachment.relPath})`);
      }
    }
  }

  for (const [family, spec] of Object.entries(TASK_FAMILIES)) {
    if (familyCounts[family] !== spec.count) {
      errors.push(`${family}: expected ${spec.count} scenarios, found ${familyCounts[family]}`);
    }
    for (const locale of ["zh", "en"]) {
      const actual = familyLocaleCounts[`${family}/${locale}`];
      if (actual !== spec.count / 2) {
        errors.push(`${family}/${locale}: expected ${spec.count / 2} scenarios, found ${actual}`);
      }
    }
  }

  if (splitCounts.core !== 100) {
    errors.push(`core split: expected 100 scenarios, found ${splitCounts.core}`);
  }
  if (splitCounts.auxiliary !== 50) {
    errors.push(`auxiliary split: expected 50 scenarios, found ${splitCounts.auxiliary}`);
  }

  if (errors.length > 0) {
    process.stderr.write(`Scenario validation failed with ${errors.length} issue(s):\n`);
    for (const error of errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `Scenario validation passed: ${files.length} files, ${ids.size} unique scenarios, ` +
    `${familyCounts.standard_workflow}/${familyCounts.interactive_robustness}/` +
    `${familyCounts.multimodal_reverse_engineering} by task family.\n`,
  );
}

validate();
