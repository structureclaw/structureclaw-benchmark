#!/usr/bin/env node

// Generates DXF (AutoCAD Drawing Exchange Format) files from ground-truth models.
// 3D frame models get isometric projections; 2D models get plan views.
// Usage: node tests/llm-benchmark/fixtures/dxf-generator.mjs

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modelsPath = join(__dirname, "ground-truth-models.json");
const outDir = join(__dirname, "drawings");
mkdirSync(outDir, { recursive: true });

const models = JSON.parse(readFileSync(modelsPath, "utf-8"));

// --- DXF builder ---

function dxfHeader() {
  return [
    "0", "SECTION",
    "2", "HEADER",
    "9", "$ACADVER",
    "1", "AC1009",
    "9", "$EXTMIN",
    "10", "-50",
    "20", "-50",
    "30", "0",
    "9", "$EXTMAX",
    "10", "50",
    "20", "50",
    "30", "0",
    "0", "ENDSEC",
  ];
}

function dxfTables() {
  return [
    "0", "SECTION",
    "2", "TABLES",
    // LTYPE table
    "0", "TABLE",
    "2", "LTYPE",
    "70", "1",
    "0", "LTYPE",
    "2", "CONTINUOUS",
    "70", "0",
    "3", "Solid line",
    "72", "65",
    "73", "0",
    "40", "0",
    "0", "ENDTAB",
    // LAYER table
    "0", "TABLE",
    "2", "LAYER",
    "70", "5",
    // Layer: 0 (default)
    "0", "LAYER",
    "2", "0",
    "70", "0",
    "62", "7",
    "6", "CONTINUOUS",
    // Layer: STRUCT
    "0", "LAYER",
    "2", "STRUCT",
    "70", "0",
    "62", "7",
    "6", "CONTINUOUS",
    // Layer: DIM
    "0", "LAYER",
    "2", "DIM",
    "70", "0",
    "62", "5",
    "6", "CONTINUOUS",
    // Layer: GRID
    "0", "LAYER",
    "2", "GRID",
    "70", "0",
    "62", "8",
    "6", "CONTINUOUS",
    // Layer: LOAD
    "0", "LAYER",
    "2", "LOAD",
    "70", "0",
    "62", "1",
    "6", "CONTINUOUS",
    "0", "ENDTAB",
    // STYLE table
    "0", "TABLE",
    "2", "STYLE",
    "70", "1",
    "0", "STYLE",
    "2", "STANDARD",
    "70", "0",
    "40", "0",
    "41", "1",
    "50", "0",
    "71", "0",
    "42", "0.2",
    "3", "txt",
    "4", "",
    "0", "ENDTAB",
    // VIEW table
    "0", "TABLE",
    "2", "VIEW",
    "70", "0",
    "0", "ENDTAB",
    // VPORT table
    "0", "TABLE",
    "2", "VPORT",
    "70", "1",
    "0", "VPORT",
    "2", "*ACTIVE",
    "70", "0",
    "10", "0",
    "20", "0",
    "11", "1",
    "21", "1",
    "12", "0",
    "22", "0",
    "13", "0",
    "23", "0",
    "14", "10",
    "24", "10",
    "15", "10",
    "25", "10",
    "16", "0",
    "26", "0",
    "36", "1",
    "17", "0",
    "27", "0",
    "37", "0",
    "40", "50",
    "41", "1",
    "42", "50",
    "43", "0",
    "44", "0",
    "50", "0",
    "51", "0",
    "71", "0",
    "72", "100",
    "73", "1",
    "74", "3",
    "75", "0",
    "76", "0",
    "0", "ENDTAB",
    "0", "ENDSEC",
  ];
}

function dxfLine(x1, y1, x2, y2, layer = "STRUCT") {
  return [
    "0", "LINE",
    "8", layer,
    "10", x1.toFixed(4),
    "20", y1.toFixed(4),
    "30", "0",
    "11", x2.toFixed(4),
    "21", y2.toFixed(4),
    "31", "0",
  ];
}

function dxfText(x, y, height, text, layer = "TEXT") {
  return [
    "0", "TEXT",
    "8", layer,
    "10", x.toFixed(4),
    "20", y.toFixed(4),
    "30", "0",
    "40", height.toFixed(2),
    "1", text,
  ];
}

function dxfEntities(entities) {
  return [
    "0", "SECTION",
    "2", "ENTITIES",
    ...entities.flat(),
    "0", "ENDSEC",
    "0", "EOF",
  ];
}

function buildDxf(entities) {
  return [...dxfHeader(), ...dxfTables(), ...dxfEntities(entities)].join("\n");
}

// --- Isometric projection for 3D ---

function isoProject(x, y, z) {
  const ix = (x - y) * Math.cos(Math.PI / 6);
  const iy = (x + y) * Math.sin(Math.PI / 6) + z;
  return { ix, iy };
}

function is3dModel(entry) {
  return entry.model.metadata?.frameDimension === "3d"
    || entry.model.nodes.some(n => n.y !== 0);
}

function storyTops(model) {
  let z = 0;
  return (model.stories || []).map((story) => {
    z += Number(story.height) || 0;
    return { ...story, topZ: z };
  });
}

function equivalentLineLoadForStory(model, storyId) {
  const storyElements = new Set(
    (model.elements || [])
      .filter((element) => element.story === storyId)
      .map((element) => element.id)
  );
  for (const loadCase of model.load_cases || []) {
    for (const load of loadCase.loads || []) {
      if (load.type === "distributed" && storyElements.has(load.element)) {
        const value = Math.abs(load.wz || load.wy || 0);
        if (value > 0) return value;
      }
    }
  }
  return 0;
}

function storyLoadLabel(model, story) {
  const areaLoad = Math.abs(Number(story.floorLoad) || 0);
  const lineLoad = equivalentLineLoadForStory(model, story.id);
  if (areaLoad > 0) return `${story.id} floor load ${fmt(areaLoad)} kN/m2`;
  if (lineLoad > 0) return `${story.id} X-beam UDL ${fmt(lineLoad)} kN/m`;
  return "";
}

function groupedDistributedLoads(model) {
  const groups = new Map();
  for (const lc of model.load_cases || []) {
    for (const load of lc.loads || []) {
      if (load.type !== "distributed") continue;
      const elementId = load.element;
      const w = Math.abs(load.wz || load.wy || 0);
      if (!elementId || w <= 0) continue;
      if (!groups.has(elementId)) groups.set(elementId, { elementId, loads: [] });
      groups.get(elementId).loads.push({ caseId: lc.id, w });
    }
  }
  return [...groups.values()];
}

function distributedLoadLabel(loads) {
  if (loads.length === 1) return `${fmt(loads[0].w)} kN/m`;
  return `${fmt(loads.reduce((sum, load) => sum + load.w, 0))} kN/m`;
}

// --- Render 2D models to DXF ---

function render2dDxf(entry) {
  const { model } = entry;
  const nodes = model.nodes;
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const entities = [];

  // Elements as lines
  for (const el of model.elements) {
    const n1 = nodeMap.get(el.nodes[0]);
    const n2 = nodeMap.get(el.nodes[1]);
    if (!n1 || !n2) continue;
    entities.push(dxfLine(n1.x, n1.z, n2.x, n2.z, "STRUCT"));
  }

  // Dimension annotations
  const xs = [...new Set(nodes.map(n => n.x))].sort((a, b) => a - b);
  const zs = [...new Set(nodes.map(n => n.z))].sort((a, b) => a - b);
  const minX = Math.min(...xs);
  const maxZ = Math.max(...zs);

  // Span dimensions
  if (xs.length >= 2) {
    for (let i = 0; i < xs.length - 1; i++) {
      const span = xs[i + 1] - xs[i];
      if (span > 0) {
        const mx = (xs[i] + xs[i + 1]) / 2;
        entities.push(dxfText(mx, -2, 0.5, `${fmt(span)}m`, "DIM"));
      }
    }
  }

  // Height dimensions
  if (zs.length >= 2) {
    for (let i = 0; i < zs.length - 1; i++) {
      const h = zs[i + 1] - zs[i];
      if (h > 0) {
        entities.push(dxfText(-2, (zs[i] + zs[i + 1]) / 2, 0.5, `${fmt(h)}m`, "DIM"));
      }
    }
  }

  // Total span
  if (xs.length >= 2) {
    const totalSpan = xs[xs.length - 1] - xs[0];
    entities.push(dxfText((xs[0] + xs[xs.length - 1]) / 2, -(maxZ > 0 ? 4 : 3), 0.6, `Total: ${fmt(totalSpan)}m`, "DIM"));
  }

  // Load annotations
  for (const group of groupedDistributedLoads(model)) {
    const el = model.elements.find(e => e.id === group.elementId);
    if (!el) continue;
    const n1 = nodeMap.get(el.nodes[0]);
    const n2 = nodeMap.get(el.nodes[1]);
    const mx = (n1.x + n2.x) / 2;
    const mz = Math.max(n1.z, n2.z);
    entities.push(dxfText(mx, mz + 1, 0.5, distributedLoadLabel(group.loads), "LOAD"));
  }
  for (const lc of model.load_cases || []) {
    for (const load of lc.loads || []) {
      if (load.node) {
        const n = nodeMap.get(load.node);
        if (!n) continue;
        const fz = Math.abs(load.fz || 0);
        if (fz > 0) {
          entities.push(dxfText(n.x + 0.3, n.z + 1, 0.5, `${fmt(fz)} kN`, "LOAD"));
        }
      }
    }
  }

  // Title (ASCII-safe)
  const matName = model.materials?.[0]?.name || "steel";
  const titleEn = `Span ${fmt(xs[xs.length - 1] - xs[0])}m | ${matName}`;
  entities.push(dxfText(0, maxZ + 3, 0.8, titleEn, "TEXT"));

  return buildDxf(entities);
}

// --- Render 3D models to DXF (isometric) ---

function render3dDxf(entry) {
  const { model } = entry;
  const nodes = model.nodes;
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const entities = [];

  const columns = model.elements.filter(e => e.type === "column");
  const beams = model.elements.filter(e => e.type !== "column");

  // Columns
  for (const el of columns) {
    const n1 = nodeMap.get(el.nodes[0]);
    const n2 = nodeMap.get(el.nodes[1]);
    if (!n1 || !n2) continue;
    const p1 = isoProject(n1.x, n1.y, n1.z);
    const p2 = isoProject(n2.x, n2.y, n2.z);
    entities.push(dxfLine(p1.ix, p1.iy, p2.ix, p2.iy, "STRUCT"));
  }

  // Beams
  for (const el of beams) {
    const n1 = nodeMap.get(el.nodes[0]);
    const n2 = nodeMap.get(el.nodes[1]);
    if (!n1 || !n2) continue;
    const p1 = isoProject(n1.x, n1.y, n1.z);
    const p2 = isoProject(n2.x, n2.y, n2.z);
    entities.push(dxfLine(p1.ix, p1.iy, p2.ix, p2.iy, "STRUCT"));
  }

  // Ground grid
  const xs = [...new Set(nodes.map(n => n.x))].sort((a, b) => a - b);
  const ys = [...new Set(nodes.map(n => n.y))].sort((a, b) => a - b);
  const zs = [...new Set(nodes.map(n => n.z))].sort((a, b) => a - b);
  const xMax = Math.max(...xs);
  const yMax = Math.max(...ys);
  const zMax = Math.max(...zs);

  for (const y of ys) {
    const p1 = isoProject(0, y, 0);
    const p2 = isoProject(xMax, y, 0);
    entities.push(dxfLine(p1.ix, p1.iy, p2.ix, p2.iy, "GRID"));
  }
  for (const x of xs) {
    const p1 = isoProject(x, 0, 0);
    const p2 = isoProject(x, yMax, 0);
    entities.push(dxfLine(p1.ix, p1.iy, p2.ix, p2.iy, "GRID"));
  }

  // Dimension labels
  const cx = isoProject(xMax / 2, 0, 0);
  entities.push(dxfText(cx.ix, cx.iy - 1.5, 0.6, `X: ${fmt(xMax)}m`, "DIM"));

  const cy = isoProject(0, yMax / 2, 0);
  entities.push(dxfText(cy.ix - 2, cy.iy, 0.6, `Y: ${fmt(yMax)}m`, "DIM"));

  const ch = isoProject(xMax, 0, zMax / 2);
  entities.push(dxfText(ch.ix + 1, ch.iy, 0.6, `H: ${fmt(zMax)}m`, "DIM"));

  // Story heights
  let zAcc = 0;
  for (let i = 0; i < zs.length - 1; i++) {
    const h = zs[i + 1] - zs[i];
    if (h > 0) {
      const pm = isoProject(xMax + 1.5, 0, zAcc + h / 2);
      entities.push(dxfText(pm.ix, pm.iy, 0.4, `${fmt(h)}m`, "DIM"));
      zAcc += h;
    }
  }

  // Floor load labels, one per story at the cumulative floor elevation.
  for (const story of storyTops(model)) {
    const label = storyLoadLabel(model, story);
    if (!label) continue;
    const pm = isoProject(xMax / 2, yMax / 2, story.topZ);
    entities.push(dxfText(pm.ix, pm.iy + 0.8, 0.4, label, "LOAD"));
  }

  // Title (ASCII-safe)
  const matName3d = model.materials?.[0]?.name || "steel";
  const title3d = `3D Frame | X ${fmt(xMax)}m x Y ${fmt(yMax)}m x H ${fmt(zMax)}m | ${matName3d}`;
  const ct = isoProject(xMax / 2, yMax / 2, zMax);
  entities.push(dxfText(ct.ix, ct.iy + 3, 0.8, title3d, "TEXT"));

  return buildDxf(entities);
}

// --- Format helper ---

function fmt(n) {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

// --- Main ---

for (const model of models) {
  const is3d = is3dModel(model);
  const dxf = is3d ? render3dDxf(model) : render2dDxf(model);
  const outPath = join(outDir, `${model.id}.dxf`);
  writeFileSync(outPath, dxf, "utf-8");

  // Count entities
  const lineCount = (dxf.match(/^LINE$/gm) || []).length;
  const textCount = (dxf.match(/^(?:TEXT|MTEXT)$/gm) || []).length;
  console.log(`  ${model.id}.dxf: ${lineCount} lines, ${textCount} texts${is3d ? " (3D)" : ""}`);
}

console.log(`\nGenerated ${models.length} DXF files.`);
