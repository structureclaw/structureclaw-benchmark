#!/usr/bin/env node

// Renders ground-truth models into structural plan drawings (PNG).
// Two styles per model: construction-plan and mechanics-diagram.
// Usage: node tests/llm-benchmark/fixtures/plan-renderer.mjs

import sharp from "sharp";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modelsPath = join(__dirname, "ground-truth-models.json");
const outDir = join(__dirname, "drawings");
mkdirSync(outDir, { recursive: true });

const models = JSON.parse(readFileSync(modelsPath, "utf-8"));

// --- SVG generation helpers ---

/** Format a number for dimension labels: integer if whole, 1 decimal otherwise */
function fmt(n) {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

const COLORS = {
  member: "#222",
  grid: "#8ab4f8",
  gridLine: "#cce0ff",
  dim: "#1565c0",
  dimLine: "#90caf9",
  load: "#c62828",
  loadArrow: "#d32f2f",
  support: "#555",
  label: "#333",
  section: "#6a1b9a",
  title: "#111",
  bg: "#fff",
  node: "#1565c0",
};

function svgWrap(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="${COLORS.bg}"/>
    <style>
      text { font-family: 'Courier New', 'SimHei', monospace; }
    </style>
    ${body}
  </svg>`;
}

function makeTransform(nodes, padding = { l: 140, r: 140, t: 90, b: 140 }, w = 960, h = 600) {
  const xs = nodes.map(n => n.x);
  const zs = nodes.map(n => n.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const dataW = maxX - minX || 1;
  const dataH = maxZ - minZ || 1;
  const drawW = w - padding.l - padding.r;
  const drawH = h - padding.t - padding.b;
  const scale = Math.min(drawW / dataW, drawH / dataH);
  const ox = padding.l + (drawW - dataW * scale) / 2;
  const oy = padding.t + (drawH - dataH * scale) / 2;
  const tx = (x) => ox + (x - minX) * scale;
  const tz = (z) => oy + (maxZ - z) * scale;
  return { tx, tz, scale, minX, maxX, minZ, maxZ, w, h, padding };
}

function pinSupport(cx, cy) {
  return `<polygon points="${cx},${cy} ${cx - 10},${cy + 14} ${cx + 10},${cy + 14}" fill="none" stroke="${COLORS.support}" stroke-width="2"/>
    <line x1="${cx - 14}" y1="${cy + 16}" x2="${cx + 14}" y2="${cy + 16}" stroke="${COLORS.support}" stroke-width="2"/>`;
}

function rollerSupport(cx, cy) {
  return `<polygon points="${cx},${cy} ${cx - 10},${cy + 14} ${cx + 10},${cy + 14}" fill="none" stroke="${COLORS.support}" stroke-width="2"/>
    <circle cx="${cx - 6}" cy="${cy + 18}" r="3" fill="none" stroke="${COLORS.support}" stroke-width="1.5"/>
    <circle cx="${cx + 6}" cy="${cy + 18}" r="3" fill="none" stroke="${COLORS.support}" stroke-width="1.5"/>
    <line x1="${cx - 14}" y1="${cy + 22}" x2="${cx + 14}" y2="${cy + 22}" stroke="${COLORS.support}" stroke-width="2"/>`;
}

function fixedSupport(cx, cy, vertical = true) {
  if (vertical) {
    return `<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy + 20}" stroke="${COLORS.support}" stroke-width="3"/>
      <line x1="${cx - 12}" y1="${cy + 20}" x2="${cx + 12}" y2="${cy + 20}" stroke="${COLORS.support}" stroke-width="3"/>
      ${[0,1,2,3].map(i => `<line x1="${cx - 10 + i * 7}" y1="${cy + 20}" x2="${cx - 14 + i * 7}" y2="${cy + 26}" stroke="${COLORS.support}" stroke-width="1.5"/>`).join("")}`;
  }
  return `<line x1="${cx}" y1="${cy}" x2="${cx + 20}" y2="${cy}" stroke="${COLORS.support}" stroke-width="3"/>
    <line x1="${cx + 20}" y1="${cy - 12}" x2="${cx + 20}" y2="${cy + 12}" stroke="${COLORS.support}" stroke-width="3"/>`;
}

function dimLine(x1, y1, x2, y2, label, offset = 25) {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const isHorizontal = Math.abs(y1 - y2) < 2;
  if (isHorizontal) {
    const dy = y1 + offset;
    return `<line x1="${x1}" y1="${y1}" x2="${x1}" y2="${dy + 5}" stroke="${COLORS.dimLine}" stroke-width="0.8" stroke-dasharray="3,2"/>
      <line x1="${x2}" y1="${y2}" x2="${x2}" y2="${dy + 5}" stroke="${COLORS.dimLine}" stroke-width="0.8" stroke-dasharray="3,2"/>
      <line x1="${x1}" y1="${dy}" x2="${x2}" y2="${dy}" stroke="${COLORS.dim}" stroke-width="1"/>
      <text x="${mx}" y="${dy + 14}" text-anchor="middle" font-size="13" fill="${COLORS.dim}" font-weight="bold">${label}</text>`;
  }
  const dx = x1 - offset;
  return `<line x1="${x1}" y1="${y1}" x2="${dx - 5}" y2="${y1}" stroke="${COLORS.dimLine}" stroke-width="0.8" stroke-dasharray="3,2"/>
    <line x1="${x2}" y1="${y2}" x2="${dx - 5}" y2="${y2}" stroke="${COLORS.dimLine}" stroke-width="0.8" stroke-dasharray="3,2"/>
    <line x1="${dx}" y1="${y1}" x2="${dx}" y2="${y2}" stroke="${COLORS.dim}" stroke-width="1"/>
    <text x="${dx - 8}" y="${my + 4}" text-anchor="end" font-size="13" fill="${COLORS.dim}" font-weight="bold">${label}</text>`;
}

// --- Style A: Construction Plan ---

function renderConstructionPlan(entry) {
  const { id, description, model } = entry;
  const nodes = model.nodes;
  const t = makeTransform(nodes, { l: 140, r: 140, t: 75, b: 140 }, 960, 620);
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  let body = "";

  // Title block (wide enough for CJK descriptions)
  body += `<rect x="10" y="6" width="${t.w - 20}" height="55" fill="#f5f5f5" stroke="#ccc" stroke-width="1" rx="3"/>`;
  body += `<text x="20" y="24" font-size="13" fill="${COLORS.title}" font-weight="bold">${description}</text>`;
  const matName = model.materials?.[0]?.name || "steel";
  const secName = model.sections?.map(s => s.name).join(", ") || "";
  body += `<text x="20" y="40" font-size="11" fill="${COLORS.label}">Material: ${matName}</text>`;
  body += `<text x="20" y="54" font-size="11" fill="${COLORS.section}">Section: ${secName}</text>`;

  // Grid lines
  const xs = [...new Set(nodes.map(n => n.x))].sort((a, b) => a - b);
  const zs = [...new Set(nodes.map(n => n.z))].sort((a, b) => a - b);

  for (const x of xs) {
    const sx = t.tx(x);
    body += `<line x1="${sx}" y1="${t.padding.t - 20}" x2="${sx}" y2="${t.h - t.padding.b + 20}" stroke="${COLORS.gridLine}" stroke-width="0.6" stroke-dasharray="6,4"/>`;
  }
  for (const z of zs) {
    const sy = t.tz(z);
    body += `<line x1="${t.padding.l - 20}" y1="${sy}" x2="${t.w - t.padding.r + 20}" y2="${sy}" stroke="${COLORS.gridLine}" stroke-width="0.6" stroke-dasharray="6,4"/>`;
  }

  // Elements
  for (const el of model.elements) {
    const n1 = nodeMap.get(el.nodes[0]);
    const n2 = nodeMap.get(el.nodes[1]);
    if (!n1 || !n2) continue;
    const x1 = t.tx(n1.x), y1 = t.tz(n1.z);
    const x2 = t.tx(n2.x), y2 = t.tz(n2.z);
    const sw = el.type === "column" ? 4 : el.type === "truss" ? 2 : 3;
    body += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${COLORS.member}" stroke-width="${sw}" stroke-linecap="round"/>`;
  }

  // Supports
  for (const n of nodes) {
    const sx = t.tx(n.x), sy = t.tz(n.z);
    if (!n.restraints) continue;
    const isFixed = n.restraints[0] && n.restraints[1] && n.restraints[4];
    const isPinned = n.restraints[1] && !n.restraints[0];
    const isRoller = !n.restraints[0] && n.restraints[1];
    if (isFixed) body += fixedSupport(sx, sy);
    else if (isPinned) body += pinSupport(sx, sy);
    else if (isRoller) body += rollerSupport(sx, sy);
  }

  // Section callout bubbles
  for (const el of model.elements) {
    if (el.type !== "beam" && el.type !== "column") continue;
    const sec = model.sections?.find(s => s.id === el.section);
    if (!sec) continue;
    const n1 = nodeMap.get(el.nodes[0]);
    const n2 = nodeMap.get(el.nodes[1]);
    const mx = (t.tx(n1.x) + t.tx(n2.x)) / 2;
    const my = (t.tz(n1.z) + t.tz(n2.z)) / 2;
    const offsetY = el.type === "column" ? -28 : 22;
    const name = sec.name;
    const r = Math.max(16, name.length * 4 + 4);
    const fs = name.length > 10 ? 7 : name.length > 6 ? 8 : 9;
    body += `<rect x="${mx - r}" y="${my + offsetY - 10}" width="${r * 2}" height="20" fill="#f3e5f5" stroke="${COLORS.section}" stroke-width="1" rx="3"/>`;
    body += `<text x="${mx}" y="${my + offsetY + 3}" text-anchor="middle" font-size="${fs}" fill="${COLORS.section}">${name}</text>`;
  }

  // Loads
  for (const lc of model.load_cases || []) {
    for (const load of lc.loads || []) {
      if (load.type === "distributed") {
        const el = model.elements.find(e => e.id === load.element);
        if (!el) continue;
        const n1 = nodeMap.get(el.nodes[0]);
        const n2 = nodeMap.get(el.nodes[1]);
        const x1 = t.tx(n1.x), y1 = t.tz(n1.z);
        const x2 = t.tx(n2.x), y2 = t.tz(n2.z);
        const w = Math.abs(load.wz || load.wy || 0);
        const count = Math.max(3, Math.min(8, Math.round(Math.hypot(x2 - x1, y2 - y1) / 30)));
        for (let i = 0; i <= count; i++) {
          const frac = i / count;
          const ax = x1 + (x2 - x1) * frac;
          const ay = y1 + (y2 - y1) * frac;
          body += `<line x1="${ax}" y1="${ay - 30}" x2="${ax}" y2="${ay - 4}" stroke="${COLORS.loadArrow}" stroke-width="1.5"/>`;
          body += `<polygon points="${ax - 3},${ay - 8} ${ax + 3},${ay - 8} ${ax},${ay - 2}" fill="${COLORS.loadArrow}"/>`;
        }
        const lx = (x1 + x2) / 2, ly = (y1 + y2) / 2 - 38;
        body += `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="12" fill="${COLORS.load}" font-weight="bold">${fmt(w)} kN/m</text>`;
      } else if (load.node) {
        const n = nodeMap.get(load.node);
        if (!n) continue;
        const sx = t.tx(n.x), sy = t.tz(n.z);
        const fz = Math.abs(load.fz || 0);
        if (fz > 0) {
          body += `<line x1="${sx}" y1="${sy - 40}" x2="${sx}" y2="${sy - 5}" stroke="${COLORS.loadArrow}" stroke-width="2"/>`;
          body += `<polygon points="${sx - 4},${sy - 9} ${sx + 4},${sy - 9} ${sx},${sy - 2}" fill="${COLORS.loadArrow}"/>`;
          body += `<text x="${sx + 8}" y="${sy - 25}" font-size="12" fill="${COLORS.load}" font-weight="bold">${fmt(fz)} kN</text>`;
        }
      }
    }
  }

  // Dimension lines
  if (xs.length >= 2) {
    for (let i = 0; i < xs.length - 1; i++) {
      const span = xs[i + 1] - xs[i];
      if (span > 0) body += dimLine(t.tx(xs[i]), t.tz(Math.min(...zs)), t.tx(xs[i + 1]), t.tz(Math.min(...zs)), `${fmt(span)}m`, 35 + (xs.length - 2) * 12);
    }
  }
  if (zs.length >= 2) {
    for (let i = 0; i < zs.length - 1; i++) {
      const h = zs[i + 1] - zs[i];
      if (h > 0) body += dimLine(t.tx(Math.min(...xs)), t.tz(zs[i]), t.tx(Math.min(...xs)), t.tz(zs[i + 1]), `${fmt(h)}m`, 40);
    }
  }

  return svgWrap(t.w, t.h, body);
}

// --- Style B: Mechanics Diagram ---

function renderMechanicsDiagram(entry) {
  const { id, description, model } = entry;
  const nodes = model.nodes;
  const t = makeTransform(nodes, { l: 120, r: 140, t: 80, b: 130 }, 920, 550);
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  let body = "";

  // Title
  body += `<text x="${t.w / 2}" y="25" text-anchor="middle" font-size="14" fill="${COLORS.title}" font-weight="bold">${description}</text>`;

  // Elements
  for (const el of model.elements) {
    const n1 = nodeMap.get(el.nodes[0]);
    const n2 = nodeMap.get(el.nodes[1]);
    if (!n1 || !n2) continue;
    body += `<line x1="${t.tx(n1.x)}" y1="${t.tz(n1.z)}" x2="${t.tx(n2.x)}" y2="${t.tz(n2.z)}" stroke="${COLORS.member}" stroke-width="2.5" stroke-linecap="round"/>`;
  }

  // Nodes
  for (const n of nodes) {
    const sx = t.tx(n.x), sy = t.tz(n.z);
    body += `<circle cx="${sx}" cy="${sy}" r="4" fill="${COLORS.node}"/>`;
    body += `<text x="${sx + 8}" y="${sy - 8}" font-size="10" fill="${COLORS.node}">${n.id}</text>`;
  }

  // Supports
  for (const n of nodes) {
    if (!n.restraints) continue;
    const sx = t.tx(n.x), sy = t.tz(n.z);
    const isFixed = n.restraints[0] && n.restraints[1] && n.restraints[4];
    const isPinned = n.restraints[1] && !n.restraints[0];
    const isRoller = !n.restraints[0] && n.restraints[1];
    if (isFixed) body += fixedSupport(sx, sy);
    else if (isPinned) body += pinSupport(sx, sy);
    else if (isRoller) body += rollerSupport(sx, sy);
  }

  // Loads
  for (const lc of model.load_cases || []) {
    for (const load of lc.loads || []) {
      if (load.type === "distributed") {
        const el = model.elements.find(e => e.id === load.element);
        if (!el) continue;
        const n1 = nodeMap.get(el.nodes[0]);
        const n2 = nodeMap.get(el.nodes[1]);
        const x1 = t.tx(n1.x), y1 = t.tz(n1.z);
        const x2 = t.tx(n2.x), y2 = t.tz(n2.z);
        const w = Math.abs(load.wz || load.wy || 0);
        const count = Math.max(2, Math.min(6, Math.round(Math.hypot(x2 - x1, y2 - y1) / 40)));
        for (let i = 0; i <= count; i++) {
          const frac = i / count;
          const ax = x1 + (x2 - x1) * frac;
          const ay = y1 + (y2 - y1) * frac;
          body += `<line x1="${ax}" y1="${ay - 28}" x2="${ax}" y2="${ay - 4}" stroke="${COLORS.loadArrow}" stroke-width="1.5"/>`;
          body += `<polygon points="${ax - 3},${ay - 8} ${ax + 3},${ay - 8} ${ax},${ay - 2}" fill="${COLORS.loadArrow}"/>`;
        }
        body += `<line x1="${x1}" y1="${y1 - 28}" x2="${x2}" y2="${y2 - 28}" stroke="${COLORS.loadArrow}" stroke-width="1"/>`;
        const lx = (x1 + x2) / 2, ly = Math.min(y1, y2) - 36;
        body += `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="12" fill="${COLORS.load}" font-weight="bold">${fmt(w)} kN/m</text>`;
      } else if (load.node) {
        const n = nodeMap.get(load.node);
        if (!n) continue;
        const sx = t.tx(n.x), sy = t.tz(n.z);
        const fz = Math.abs(load.fz || 0);
        if (fz > 0) {
          body += `<line x1="${sx}" y1="${sy - 35}" x2="${sx}" y2="${sy - 5}" stroke="${COLORS.loadArrow}" stroke-width="2"/>`;
          body += `<polygon points="${sx - 4},${sy - 9} ${sx + 4},${sy - 9} ${sx},${sy - 2}" fill="${COLORS.loadArrow}"/>`;
          body += `<text x="${sx + 8}" y="${sy - 20}" font-size="12" fill="${COLORS.load}" font-weight="bold">${fmt(fz)} kN</text>`;
        }
      }
    }
  }

  // Key dimensions
  const xs = [...new Set(nodes.map(n => n.x))].sort((a, b) => a - b);
  const zs = [...new Set(nodes.map(n => n.z))].sort((a, b) => a - b);
  if (xs.length >= 2) {
    body += dimLine(t.tx(xs[0]), t.tz(Math.min(...zs)), t.tx(xs[xs.length - 1]), t.tz(Math.min(...zs)), `${fmt(xs[xs.length - 1] - xs[0])}m`, 35);
  }
  if (zs.length >= 2) {
    body += dimLine(t.tx(Math.min(...xs)), t.tz(zs[0]), t.tx(Math.min(...xs)), t.tz(zs[zs.length - 1]), `${fmt(zs[zs.length - 1] - zs[0])}m`, 35);
  }

  return svgWrap(t.w, t.h, body);
}

// --- 3D Isometric Rendering ---

/** Isometric projection in SVG screen coordinates: x-right-down, y-left-down, z-up */
function isoProject(x, y, z) {
  const ix = (x - y) * Math.cos(Math.PI / 6);
  const iy = (x + y) * Math.sin(Math.PI / 6) - z;
  return { ix, iy };
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

function make3dTransform(nodes, padding = { l: 120, r: 140, t: 75, b: 140 }, w = 960, h = 640) {
  const projected = nodes.map(n => isoProject(n.x, n.y, n.z));
  const ixs = projected.map(p => p.ix);
  const iys = projected.map(p => p.iy);
  const minIx = Math.min(...ixs), maxIx = Math.max(...ixs);
  const minIy = Math.min(...iys), maxIy = Math.max(...iys);
  const dataW = maxIx - minIx || 1;
  const dataH = maxIy - minIy || 1;
  const drawW = w - padding.l - padding.r;
  const drawH = h - padding.t - padding.b;
  const scale = Math.min(drawW / dataW, drawH / dataH);
  const ox = padding.l + (drawW - dataW * scale) / 2;
  const oy = padding.t + (drawH - dataH * scale) / 2;
  const tx = (x, y, z) => {
    const { ix } = isoProject(x, y, z);
    return ox + (ix - minIx) * scale;
  };
  const ty = (x, y, z) => {
    const { iy } = isoProject(x, y, z);
    return oy + (iy - minIy) * scale;
  };
  return { tx, ty, scale, w, h, padding, minIx, maxIx, minIy, maxIy };
}

function render3dConstruction(entry) {
  const { id, description, model } = entry;
  const nodes = model.nodes;
  const t = make3dTransform(nodes, { l: 120, r: 140, t: 75, b: 140 }, 960, 640);
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  let body = "";

  // Title block
  body += `<rect x="10" y="6" width="${t.w - 20}" height="55" fill="#f5f5f5" stroke="#ccc" stroke-width="1" rx="3"/>`;
  body += `<text x="20" y="24" font-size="13" fill="${COLORS.title}" font-weight="bold">${description}</text>`;
  const matName = model.materials?.[0]?.name || "steel";
  const secName = model.sections?.map(s => s.name).join(", ") || "";
  body += `<text x="20" y="40" font-size="11" fill="${COLORS.label}">Material: ${matName}</text>`;
  body += `<text x="20" y="54" font-size="11" fill="${COLORS.section}">Section: ${secName}</text>`;

  // Grid lines at ground level (z=0)
  const ys = [...new Set(nodes.map(n => n.y))].sort((a, b) => a - b);
  const xs = [...new Set(nodes.map(n => n.x))].sort((a, b) => a - b);
  const zs = [...new Set(nodes.map(n => n.z))].sort((a, b) => a - b);
  const zMax = Math.max(...zs);
  const xMax = Math.max(...xs);
  const yMax = Math.max(...ys);

  // Ground grid lines along X
  for (const y of ys) {
    const sx1 = t.tx(0, y, 0), sy1 = t.ty(0, y, 0);
    const sx2 = t.tx(xMax, y, 0), sy2 = t.ty(xMax, y, 0);
    body += `<line x1="${sx1}" y1="${sy1}" x2="${sx2}" y2="${sy2}" stroke="${COLORS.gridLine}" stroke-width="0.5" stroke-dasharray="4,3"/>`;
  }
  // Ground grid lines along Y
  for (const x of xs) {
    const sx1 = t.tx(x, 0, 0), sy1 = t.ty(x, 0, 0);
    const sx2 = t.tx(x, yMax, 0), sy2 = t.ty(x, yMax, 0);
    body += `<line x1="${sx1}" y1="${sy1}" x2="${sx2}" y2="${sy2}" stroke="${COLORS.gridLine}" stroke-width="0.5" stroke-dasharray="4,3"/>`;
  }

  // Elements - draw columns first, then beams
  const columns = model.elements.filter(e => e.type === "column");
  const beams = model.elements.filter(e => e.type !== "column");

  // Columns (thicker)
  for (const el of columns) {
    const n1 = nodeMap.get(el.nodes[0]);
    const n2 = nodeMap.get(el.nodes[1]);
    if (!n1 || !n2) continue;
    body += `<line x1="${t.tx(n1.x, n1.y, n1.z)}" y1="${t.ty(n1.x, n1.y, n1.z)}" x2="${t.tx(n2.x, n2.y, n2.z)}" y2="${t.ty(n2.x, n2.y, n2.z)}" stroke="${COLORS.member}" stroke-width="3.5" stroke-linecap="round"/>`;
  }

  // Beams - X-direction (slightly thicker than Y)
  for (const el of beams) {
    const n1 = nodeMap.get(el.nodes[0]);
    const n2 = nodeMap.get(el.nodes[1]);
    if (!n1 || !n2) continue;
    const isXBeam = n1.y === n2.y;
    const sw = isXBeam ? 2.5 : 2;
    body += `<line x1="${t.tx(n1.x, n1.y, n1.z)}" y1="${t.ty(n1.x, n1.y, n1.z)}" x2="${t.tx(n2.x, n2.y, n2.z)}" y2="${t.ty(n2.x, n2.y, n2.z)}" stroke="${COLORS.member}" stroke-width="${sw}" stroke-linecap="round"/>`;
  }

  // Supports at z=0
  for (const n of nodes) {
    if (!n.restraints) continue;
    const sx = t.tx(n.x, n.y, n.z);
    const sy = t.ty(n.x, n.y, n.z);
    body += `<rect x="${sx - 5}" y="${sy - 2}" width="10" height="10" fill="none" stroke="${COLORS.support}" stroke-width="2"/>`;
    body += `<line x1="${sx - 8}" y1="${sy + 10}" x2="${sx + 8}" y2="${sy + 10}" stroke="${COLORS.support}" stroke-width="2"/>`;
  }

  // Floor load labels, one per story at the cumulative floor elevation.
  for (const story of storyTops(model)) {
    const label = storyLoadLabel(model, story);
    if (!label) continue;
    const midX = xMax / 2, midY = yMax / 2;
    const lx = t.tx(midX, midY, story.topZ);
    const ly = t.ty(midX, midY, story.topZ);
    body += `<text x="${lx}" y="${ly - 16}" text-anchor="middle" font-size="12" fill="${COLORS.load}" font-weight="bold">${label}</text>`;
  }

  // Dimension annotations
  // Total X span
  const dxStart = t.tx(0, 0, 0);
  const dxEnd = t.tx(xMax, 0, 0);
  const dyStart = t.ty(0, 0, 0);
  const dyEnd = t.ty(xMax, 0, 0);
  body += `<text x="${(dxStart + dxEnd) / 2}" y="${Math.max(dyStart, dyEnd) + 25}" text-anchor="middle" font-size="12" fill="${COLORS.dim}" font-weight="bold">X: ${fmt(xMax)}m</text>`;

  // Total Y span
  const yxStart = t.tx(0, 0, 0);
  const yxEnd = t.tx(0, yMax, 0);
  const yyStart = t.ty(0, 0, 0);
  const yyEnd = t.ty(0, yMax, 0);
  body += `<text x="${Math.min(yxStart, yxEnd) - 30}" y="${(yyStart + yyEnd) / 2 + 4}" text-anchor="middle" font-size="12" fill="${COLORS.dim}" font-weight="bold">Y: ${fmt(yMax)}m</text>`;

  // Height
  const hxStart = t.tx(xMax, 0, 0);
  const hxEnd = t.tx(xMax, 0, zMax);
  const hyStart = t.ty(xMax, 0, 0);
  const hyEnd = t.ty(xMax, 0, zMax);
  body += `<text x="${hxEnd + 30}" y="${(hyStart + hyEnd) / 2 + 4}" text-anchor="middle" font-size="12" fill="${COLORS.dim}" font-weight="bold">H: ${fmt(zMax)}m</text>`;

  return svgWrap(t.w, t.h, body);
}

function render3dMechanics(entry) {
  const { id, description, model } = entry;
  const nodes = model.nodes;
  const t = make3dTransform(nodes, { l: 110, r: 130, t: 80, b: 120 }, 920, 580);
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  let body = "";

  // Title
  body += `<text x="${t.w / 2}" y="25" text-anchor="middle" font-size="14" fill="${COLORS.title}" font-weight="bold">${description}</text>`;

  // Elements
  const columns = model.elements.filter(e => e.type === "column");
  const beams = model.elements.filter(e => e.type !== "column");

  for (const el of columns) {
    const n1 = nodeMap.get(el.nodes[0]);
    const n2 = nodeMap.get(el.nodes[1]);
    if (!n1 || !n2) continue;
    body += `<line x1="${t.tx(n1.x, n1.y, n1.z)}" y1="${t.ty(n1.x, n1.y, n1.z)}" x2="${t.tx(n2.x, n2.y, n2.z)}" y2="${t.ty(n2.x, n2.y, n2.z)}" stroke="${COLORS.member}" stroke-width="2.5" stroke-linecap="round"/>`;
  }
  for (const el of beams) {
    const n1 = nodeMap.get(el.nodes[0]);
    const n2 = nodeMap.get(el.nodes[1]);
    if (!n1 || !n2) continue;
    body += `<line x1="${t.tx(n1.x, n1.y, n1.z)}" y1="${t.ty(n1.x, n1.y, n1.z)}" x2="${t.tx(n2.x, n2.y, n2.z)}" y2="${t.ty(n2.x, n2.y, n2.z)}" stroke="${COLORS.member}" stroke-width="1.8" stroke-linecap="round"/>`;
  }

  // Node dots
  for (const n of nodes) {
    const sx = t.tx(n.x, n.y, n.z);
    const sy = t.ty(n.x, n.y, n.z);
    body += `<circle cx="${sx}" cy="${sy}" r="3" fill="${COLORS.node}"/>`;
  }

  // Supports
  for (const n of nodes) {
    if (!n.restraints) continue;
    const sx = t.tx(n.x, n.y, n.z);
    const sy = t.ty(n.x, n.y, n.z);
    body += `<line x1="${sx - 6}" y1="${sy + 3}" x2="${sx + 6}" y2="${sy + 3}" stroke="${COLORS.support}" stroke-width="2"/>`;
  }

  // Dimensions
  const xs = [...new Set(nodes.map(n => n.x))].sort((a, b) => a - b);
  const ys = [...new Set(nodes.map(n => n.y))].sort((a, b) => a - b);
  const zs = [...new Set(nodes.map(n => n.z))].sort((a, b) => a - b);
  const xMax = Math.max(...xs), yMax = Math.max(...ys), zMax = Math.max(...zs);

  const lx1 = t.tx(xMax / 2, 0, 0), ly1 = t.ty(xMax / 2, 0, 0);
  body += `<text x="${lx1}" y="${ly1 + 20}" text-anchor="middle" font-size="12" fill="${COLORS.dim}" font-weight="bold">${fmt(xMax)}m</text>`;

  const lx2 = t.tx(0, yMax / 2, 0), ly2 = t.ty(0, yMax / 2, 0);
  body += `<text x="${lx2 - 25}" y="${ly2 + 4}" text-anchor="middle" font-size="12" fill="${COLORS.dim}" font-weight="bold">${fmt(yMax)}m</text>`;

  const lx3 = t.tx(xMax, 0, zMax / 2), ly3 = t.ty(xMax, 0, zMax / 2);
  body += `<text x="${lx3 + 25}" y="${ly3 + 4}" text-anchor="middle" font-size="12" fill="${COLORS.dim}" font-weight="bold">${fmt(zMax)}m</text>`;

  // Floor loads
  for (const story of storyTops(model)) {
    const label = storyLoadLabel(model, story);
    if (!label) continue;
    const midX = xMax / 2;
    const midY = yMax / 2;
    const lx = t.tx(midX, midY, story.topZ);
    const ly = t.ty(midX, midY, story.topZ);
    body += `<text x="${lx}" y="${ly - 18}" text-anchor="middle" font-size="12" fill="${COLORS.load}" font-weight="bold">${label}</text>`;
    for (const xFrac of [0.25, 0.5, 0.75]) {
      const ax = t.tx(xMax * xFrac, midY, story.topZ + 0.65);
      const ay1 = t.ty(xMax * xFrac, midY, story.topZ + 0.65);
      const ay2 = t.ty(xMax * xFrac, midY, story.topZ + 0.08);
      body += `<line x1="${ax}" y1="${ay1}" x2="${ax}" y2="${ay2}" stroke="${COLORS.loadArrow}" stroke-width="1.5"/>`;
      body += `<polygon points="${ax - 3},${ay2 - 6} ${ax + 3},${ay2 - 6} ${ax},${ay2}" fill="${COLORS.loadArrow}"/>`;
    }
  }

  return svgWrap(t.w, t.h, body);
}

function is3dModel(entry) {
  return entry.model.metadata?.frameDimension === "3d"
    || entry.model.nodes.some(n => n.y !== 0);
}

// --- Main ---

async function renderAll() {
  for (const model of models) {
    const is3d = is3dModel(model);
    for (const style of ["construction", "mechanics"]) {
      const suffix = style === "construction" ? "construction" : "mechanics";
      const fileName = `${model.id}-${suffix}.png`;
      let svg;
      if (is3d) {
        svg = style === "construction" ? render3dConstruction(model) : render3dMechanics(model);
      } else {
        svg = style === "construction" ? renderConstructionPlan(model) : renderMechanicsDiagram(model);
      }

      const outPath = join(outDir, fileName);
      await sharp(Buffer.from(svg)).png().toFile(outPath);
      const meta = await sharp(outPath).metadata();
      console.log(`  ${fileName}: ${meta.width}x${meta.height}, ${meta.size} bytes${is3d ? " (3D)" : ""}`);
    }
  }
  console.log(`\nRendered ${models.length * 2} drawings.`);
}

renderAll().catch((err) => { console.error("Error:", err); process.exit(1); });
