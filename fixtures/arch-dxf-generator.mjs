#!/usr/bin/env node

// Generates realistic architectural floor plan DXF files from ground-truth models.
// Adds walls, doors, windows, furniture, room labels, dimensions, and grid axes
// around the structural members to simulate real-world CAD drawings.
// Usage: node tests/llm-benchmark/fixtures/arch-dxf-generator.mjs

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modelsPath = join(__dirname, "ground-truth-models.json");
const outDir = join(__dirname, "drawings");
mkdirSync(outDir, { recursive: true });

const models = JSON.parse(readFileSync(modelsPath, "utf-8"));

// Select models suitable for architectural floor plans (frames and portal-frames)
const selectedIds = [
  "frame-simple-1s1b",
  "frame-complex-2s2b",
  "frame3d-simple",
  "frame3d-complex",
  "frame3d-concrete",
  "portal-simple-18m",
];

// --- DXF primitives ---

function dxfHeader() {
  return [
    "0", "SECTION", "2", "HEADER",
    "9", "$ACADVER", "1", "AC1009",
    "9", "$EXTMIN", "10", "-60", "20", "-60", "30", "0",
    "9", "$EXTMAX", "10", "60", "20", "60", "30", "0",
    "0", "ENDSEC",
  ];
}

function dxfTables(layers) {
  const entries = [
    "0", "SECTION", "2", "TABLES",
    // LTYPE
    "0", "TABLE", "2", "LTYPE", "70", "1",
    "0", "LTYPE", "2", "CONTINUOUS", "70", "0", "3", "Solid", "72", "65", "73", "0", "40", "0",
    "0", "ENDTAB",
    // LAYER
    "0", "TABLE", "2", "LAYER", "70", String(layers.length),
  ];
  for (const [name, color] of layers) {
    entries.push("0", "LAYER", "2", name, "70", "0", "62", String(color), "6", "CONTINUOUS");
  }
  entries.push("0", "ENDTAB");
  // STYLE
  entries.push("0", "TABLE", "2", "STYLE", "70", "1");
  entries.push("0", "STYLE", "2", "STANDARD", "70", "0", "40", "0", "41", "1", "50", "0", "71", "0", "42", "0.2", "3", "txt", "4", "");
  entries.push("0", "ENDTAB");
  // VIEW
  entries.push("0", "TABLE", "2", "VIEW", "70", "0", "0", "ENDTAB");
  // VPORT
  entries.push("0", "TABLE", "2", "VPORT", "70", "1");
  entries.push("0", "VPORT", "2", "*ACTIVE", "70", "0",
    "10", "0", "20", "0", "11", "1", "21", "1",
    "12", "0", "22", "0", "13", "0", "23", "0",
    "14", "10", "24", "10", "15", "10", "25", "10",
    "16", "0", "26", "0", "36", "1", "17", "0", "27", "0", "37", "0",
    "40", "50", "41", "1", "42", "50", "43", "0", "44", "0",
    "50", "0", "51", "0", "71", "0", "72", "100", "73", "1", "74", "3", "75", "0", "76", "0");
  entries.push("0", "ENDTAB");
  entries.push("0", "ENDSEC");
  return entries;
}

function dxfLine(x1, y1, x2, y2, layer) {
  return ["0", "LINE", "8", layer,
    "10", x1.toFixed(4), "20", y1.toFixed(4), "30", "0",
    "11", x2.toFixed(4), "21", y2.toFixed(4), "31", "0"];
}

function dxfText(x, y, height, text, layer, halign) {
  const e = ["0", "TEXT", "8", layer,
    "10", x.toFixed(4), "20", y.toFixed(4), "30", "0",
    "40", height.toFixed(2), "1", text];
  if (halign !== undefined) { e.push("72", String(halign), "11", x.toFixed(4), "21", y.toFixed(4), "31", "0"); }
  return e;
}

function dxfCircle(cx, cy, r, layer) {
  return ["0", "CIRCLE", "8", layer,
    "10", cx.toFixed(4), "20", cy.toFixed(4), "30", "0",
    "40", r.toFixed(4)];
}

function dxfArc(cx, cy, r, startDeg, endDeg, layer) {
  return ["0", "ARC", "8", layer,
    "10", cx.toFixed(4), "20", cy.toFixed(4), "30", "0",
    "40", r.toFixed(4), "50", startDeg.toFixed(2), "51", endDeg.toFixed(2)];
}

/** Draw a filled rectangle using cross-hatched LINEs (more compatible than SOLID). */
function dxfFilledRect(x, y, w, h, layer) {
  const result = [];
  // Outline
  result.push(dxfLine(x, y, x + w, y, layer));
  result.push(dxfLine(x + w, y, x + w, y + h, layer));
  result.push(dxfLine(x + w, y + h, x, y + h, layer));
  result.push(dxfLine(x, y + h, x, y, layer));
  // Diagonal fill
  result.push(dxfLine(x, y, x + w, y + h, layer));
  result.push(dxfLine(x + w, y, x, y + h, layer));
  return result;
}

function buildDxf(entities, layers) {
  return [...dxfHeader(), ...dxfTables(layers),
    "0", "SECTION", "2", "ENTITIES",
    ...entities.flat(),
    "0", "ENDSEC", "0", "EOF"].join("\n");
}

// --- Architectural element generators ---

function addWall(e, x1, y1, x2, y2, thickness = 0.2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.01) return;
  const nx = -dy / len * thickness / 2;
  const ny = dx / len * thickness / 2;
  // Two parallel lines for wall
  e.push(dxfLine(x1 + nx, y1 + ny, x2 + nx, y2 + ny, "WALL"));
  e.push(dxfLine(x1 - nx, y1 - ny, x2 - nx, y2 - ny, "WALL"));
}

function addDoor(e, x, y, width = 1.0, angle = 0) {
  const openAngle = angle + Math.PI / 2;
  const dx = Math.cos(openAngle) * width;
  const dy = Math.sin(openAngle) * width;
  // Door leaf at open position
  e.push(dxfLine(x, y, x + dx, y + dy, "DOOR"));
  // Door swing arc
  e.push(dxfArc(x, y, width, angle * 180 / Math.PI, openAngle * 180 / Math.PI, "DOOR"));
}

function addWindow(e, x1, y1, x2, y2, wallT = 0.24) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.01) return;
  const nx = -dy / len;
  const ny = dx / len;
  const half = wallT / 2;
  // 4 parallel lines equally spaced across wall thickness
  const offsets = [-half, -half / 3, half / 3, half];
  for (const d of offsets) {
    e.push(dxfLine(x1 + nx * d, y1 + ny * d, x2 + nx * d, y2 + ny * d, "WINDOW"));
  }
}

function addRect(e, x, y, w, h, layer) {
  e.push(dxfLine(x, y, x + w, y, layer));
  e.push(dxfLine(x + w, y, x + w, y + h, layer));
  e.push(dxfLine(x + w, y + h, x, y + h, layer));
  e.push(dxfLine(x, y + h, x, y, layer));
}

function addTable(e, x, y, w, h) {
  addRect(e, x, y, w, h, "FURN");
  // Chair marks (small circles at midpoints)
  e.push(dxfCircle(x + w / 2, y - 0.25, 0.2, "FURN"));
  e.push(dxfCircle(x + w / 2, y + h + 0.25, 0.2, "FURN"));
}

function addBed(e, x, y, w = 2.0, h = 1.5) {
  addRect(e, x, y, w, h, "FURN");
  // Pillow
  addRect(e, x + 0.1, y + 0.1, w - 0.2, 0.3, "FURN");
}

function addSofa(e, x, y, w = 2.4, h = 0.9) {
  addRect(e, x, y, w, h, "FURN");
  addRect(e, x, y, 0.3, h, "FURN"); // back
  addRect(e, x + 0.3, y, w - 0.3, 0.25, "FURN"); // seat cushion
}

function addStaircase(e, x, y, w, h, steps = 8) {
  addRect(e, x, y, w, h, "STAIR");
  const stepH = h / steps;
  for (let i = 1; i < steps; i++) {
    e.push(dxfLine(x, y + i * stepH, x + w, y + i * stepH, "STAIR"));
  }
  // Arrow indicating up direction
  const midX = x + w / 2;
  e.push(dxfLine(midX, y + 0.3, midX, y + h - 0.3, "STAIR"));
  e.push(dxfLine(midX, y + h - 0.3, midX - 0.3, y + h - 0.8, "STAIR"));
  e.push(dxfLine(midX, y + h - 0.3, midX + 0.3, y + h - 0.8, "STAIR"));
  e.push(dxfText(midX + 0.3, y + h / 2, 0.3, "UP", "STAIR"));
}

function addToilet(e, x, y) {
  addRect(e, x, y, 0.9, 1.2, "FURN");
  e.push(dxfCircle(x + 0.45, y + 0.4, 0.35, "FURN"));
}

function addBathtub(e, x, y, w = 1.7, h = 0.8) {
  addRect(e, x, y, w, h, "FURN");
  addRect(e, x + 0.05, y + 0.05, w - 0.1, h - 0.1, "FURN");
}

// --- Plan generators ---

function renderFrame1s1bFloor(entry) {
  const model = entry.model;
  const e = [];
  const L = 6, H = 4.5;
  const wallT = 0.24;
  const offset = 0.5; // wall offset from structure

  // Outer walls
  addWall(e, -offset, -offset, L + offset, -offset, wallT); // bottom
  addWall(e, -offset, H + offset, L + offset, H + offset, wallT); // top
  addWall(e, -offset, -offset, -offset, H + offset, wallT); // left
  addWall(e, L + offset, -offset, L + offset, H + offset, wallT); // right

  // Windows on top wall
  addWindow(e, 1, H + offset, 2.5, H + offset);
  addWindow(e, 3.5, H + offset, 5, H + offset);

  // Door on bottom wall
  addDoor(e, 2.5, -offset, 1.2, 0);

  // Column marks (filled squares at structural nodes)
  for (const n of model.nodes) {
    if (n.z > 0) continue; // only ground floor plan
    e.push(...dxfFilledRect(n.x - 0.15, n.z - 0.15, 0.3, 0.3, "COLUMN"));
  }

  // Beams as dashed lines at roof level (shown on plan)
  for (const el of model.elements) {
    if (el.type !== "beam") continue;
    const nm = new Map(model.nodes.map(n => [n.id, n]));
    const n1 = nm.get(el.nodes[0]), n2 = nm.get(el.nodes[1]);
    if (!n1 || !n2) continue;
    e.push(dxfLine(n1.x, n1.z, n2.x, n2.z, "BEAM"));
  }

  // Room label
  e.push(dxfText(L / 2, H / 2 - 0.3, 0.6, "OFFICE", "ROOM", 1));
  e.push(dxfText(L / 2, H / 2 - 1, 0.3, "36.0 m2", "ROOM", 1));

  // Furniture
  addTable(e, 0.8, 0.8, 2.0, 1.0);
  addTable(e, 3.5, 0.8, 2.0, 1.0);
  addSofa(e, 1.5, 3.0, 2.4);
  addRect(e, 4.2, 3.2, 1.2, 1.0, "FURN"); // cabinet

  // Grid axes
  e.push(dxfLine(-2, 0, L + 3, 0, "GRID"));
  e.push(dxfLine(-2, H, L + 3, H, "GRID"));
  e.push(dxfLine(0, -2, 0, H + 3, "GRID"));
  e.push(dxfLine(L, -2, L, H + 3, "GRID"));
  // Grid labels
  e.push(dxfText(-2.5, 0, 0.5, "A", "GRID", 2));
  e.push(dxfText(-2.5, H, 0.5, "B", "GRID", 2));
  e.push(dxfText(0, -2.5, 0.5, "1", "GRID", 1));
  e.push(dxfText(L, -2.5, 0.5, "2", "GRID", 1));

  // Dimensions
  e.push(dxfLine(0, -1.5, L, -1.5, "DIM"));
  e.push(dxfLine(0, -1.3, 0, -1.7, "DIM"));
  e.push(dxfLine(L, -1.3, L, -1.7, "DIM"));
  e.push(dxfText(L / 2, -1.9, 0.4, "6000", "DIM", 1));

  e.push(dxfLine(-1.5, 0, -1.5, H, "DIM"));
  e.push(dxfLine(-1.3, 0, -1.7, 0, "DIM"));
  e.push(dxfLine(-1.3, H, -1.7, H, "DIM"));
  e.push(dxfText(-2, H / 2, 0.4, "4500", "DIM", 1));

  // Title
  e.push(dxfText(L / 2, H + 3, 0.5, "1F FLOOR PLAN  1:100", "DIM", 1));

  return e;
}

function renderFrame2s2bFloor(entry) {
  const model = entry.model;
  const e = [];
  const L = 11.4, H = 7.2;
  const wallT = 0.24;
  const off = 0.5;

  // Outer walls
  addWall(e, -off, -off, L + off, -off, wallT);
  addWall(e, -off, H / 2, L + off, H / 2, wallT); // corridor wall
  addWall(e, -off, H + off, L + off, H + off, wallT);
  addWall(e, -off, -off, -off, H + off, wallT);
  addWall(e, L + off, -off, L + off, H + off, wallT);

  // Internal column line walls (partial)
  addWall(e, 5.4, H / 2, 5.4, H + off, 0.12);
  // Door openings in corridor wall
  addDoor(e, 2, H / 2, 1.0, 0);
  addDoor(e, 4, H / 2, 1.0, 0);
  addDoor(e, 7, H / 2, 1.0, 0);
  addDoor(e, 9.5, H / 2, 1.0, 0);

  // Windows
  addWindow(e, 1, H + off, 2.5, H + off);
  addWindow(e, 3.5, H + off, 5, H + off);
  addWindow(e, 7, H + off, 8.5, H + off);
  addWindow(e, 9, H + off, 10.5, H + off);
  addWindow(e, 1, -off, 2.5, -off);
  addWindow(e, 4, -off, 5, -off);
  addWindow(e, 7, -off, 8.5, -off);
  addWindow(e, 9.5, -off, 10.5, -off);

  // Column marks at all structural nodes
  for (const n of model.nodes) {
    if (n.z > 0) continue;
    e.push(...dxfFilledRect(n.x - 0.2, n.z - 0.2, 0.4, 0.4, "COLUMN"));
  }

  // Beams
  for (const el of model.elements) {
    if (el.type !== "beam") continue;
    const nm = new Map(model.nodes.map(n => [n.id, n]));
    const n1 = nm.get(el.nodes[0]), n2 = nm.get(el.nodes[1]);
    if (!n1 || !n2) continue;
    e.push(dxfLine(n1.x, n1.z, n2.x, n2.z, "BEAM"));
  }

  // Staircase
  addStaircase(e, 9.5, 0.2, 1.5, 3.0);

  // Room labels and furniture
  e.push(dxfText(2.7, 5.5, 0.5, "ROOM 101", "ROOM", 1));
  e.push(dxfText(2.7, 4.8, 0.3, "27.0 m2", "ROOM", 1));
  addTable(e, 1.0, 4.0, 2.0, 1.0);
  addSofa(e, 3.5, 5.5);

  e.push(dxfText(8.5, 5.5, 0.5, "ROOM 102", "ROOM", 1));
  e.push(dxfText(8.5, 4.8, 0.3, "30.0 m2", "ROOM", 1));
  addTable(e, 7.0, 4.0, 2.0, 1.0);
  addBed(e, 9.5, 5.0, 1.6, 2.0);

  e.push(dxfText(2.7, 1.5, 0.5, "ROOM 103", "ROOM", 1));
  e.push(dxfText(2.7, 0.8, 0.3, "27.0 m2", "ROOM", 1));
  addTable(e, 1.0, 0.5, 2.0, 1.0);
  addToilet(e, 4.5, 0.3);
  addBathtub(e, 4.5, 1.8);

  e.push(dxfText(8.0, 1.5, 0.5, "CORRIDOR", "ROOM", 1));

  // Grid axes
  const xs = [0, 5.4, 11.4];
  const zs = [0, 3.6, 7.2];
  const yLabels = ["A", "B", "C"];
  const xLabels = ["1", "2", "3"];
  for (const x of xs) {
    e.push(dxfLine(x, -2.5, x, H + 3, "GRID"));
    e.push(dxfText(x, -3, 0.5, xLabels[xs.indexOf(x)], "GRID", 1));
  }
  for (const z of zs) {
    e.push(dxfLine(-2.5, z, L + 3, z, "GRID"));
    e.push(dxfText(-3, z, 0.5, yLabels[zs.indexOf(z)], "GRID", 2));
  }

  // Dimensions
  e.push(dxfLine(0, -1.8, 5.4, -1.8, "DIM"));
  e.push(dxfLine(5.4, -1.8, L, -1.8, "DIM"));
  e.push(dxfText(2.7, -2.3, 0.35, "5400", "DIM", 1));
  e.push(dxfText(8.4, -2.3, 0.35, "6000", "DIM", 1));

  e.push(dxfText(L / 2, H + 3.5, 0.5, "1F FLOOR PLAN  1:100", "DIM", 1));

  return e;
}

// 3D frame: render ground floor plan
function render3dFloorPlan(entry) {
  const model = entry.model;
  const e = [];
  const meta = model.metadata;
  const bxM = meta.geometry.bayWidthsXM;
  const byM = meta.geometry.bayWidthsYM;
  const totalX = bxM.reduce((a, b) => a + b, 0);
  const totalY = byM.reduce((a, b) => a + b, 0);
  const wallT = 0.24;
  const off = 0.5;

  // Outer walls
  addWall(e, -off, -off, totalX + off, -off, wallT);
  addWall(e, -off, totalY + off, totalX + off, totalY + off, wallT);
  addWall(e, -off, -off, -off, totalY + off, wallT);
  addWall(e, totalX + off, -off, totalX + off, totalY + off, wallT);

  // Internal walls along Y grid lines (partial)
  let xAcc = 0;
  for (let i = 0; i < bxM.length - 1; i++) {
    xAcc += bxM[i];
    addWall(e, xAcc, 0, xAcc, totalY, 0.12);
    // Door opening
    addDoor(e, xAcc, totalY / 2, 1.0, Math.PI / 2);
  }
  // Internal walls along X grid lines
  let yAcc = 0;
  for (let i = 0; i < byM.length - 1; i++) {
    yAcc += byM[i];
    addWall(e, 0, yAcc, totalX, yAcc, 0.12);
    addDoor(e, totalX / 2, yAcc, 1.0, 0);
  }

  // Windows on outer walls
  const winPositions = [];
  if (totalX > 8) {
    winPositions.push([1, totalY + off, 2.5, totalY + off]);
    winPositions.push([totalX - 2.5, totalY + off, totalX - 1, totalY + off]);
  } else {
    winPositions.push([1, totalY + off, totalX - 1, totalY + off]);
  }
  if (totalY > 6) {
    winPositions.push([totalX + off, 1, totalX + off, 3]);
    winPositions.push([totalX + off, totalY - 3, totalX + off, totalY - 1]);
  } else {
    winPositions.push([totalX + off, 1, totalX + off, totalY - 1]);
  }
  for (const [x1, y1, x2, y2] of winPositions) {
    addWindow(e, x1, y1, x2, y2);
  }

  // Doors on bottom wall
  addDoor(e, 1.5, -off, 1.0, 0);
  if (totalX > 8) addDoor(e, totalX - 2, -off, 1.0, 0);

  // Column marks at all ground-floor nodes
  for (const n of model.nodes) {
    if (n.z > 0) continue;
    const sz = 0.2;
    e.push(...dxfFilledRect(n.x - sz, n.y - sz, sz * 2, sz * 2, "COLUMN"));
  }

  // Beams at z=0 level shown on plan
  for (const el of model.elements) {
    if (el.type !== "beam" && el.type !== "column") continue;
    if (el.type === "column") continue;
    const nm = new Map(model.nodes.map(n => [n.id, n]));
    const n1 = nm.get(el.nodes[0]), n2 = nm.get(el.nodes[1]);
    if (!n1 || !n2) continue;
    // Only show beams that are at a non-zero Z (i.e. actual beams, not columns)
    if (n1.z === 0 && n2.z === 0) continue;
    // Project onto XY plan
    e.push(dxfLine(n1.x, n1.y, n2.x, n2.y, "BEAM"));
  }

  // Furniture per room
  if (totalX > 8 && totalY > 6) {
    // Large building: offices and meeting rooms
    addTable(e, 1, 1, 2, 1);
    addTable(e, 1, 3, 2, 1);
    addSofa(e, 1, totalY - 2);
    addTable(e, totalX - 3, 1, 2, 1);
    addBed(e, totalX - 2, totalY - 2, 1.6, 2.0);
    e.push(dxfText(totalX / 4, totalY / 4, 0.4, "OFFICE A", "ROOM", 1));
    e.push(dxfText(3 * totalX / 4, totalY / 4, 0.4, "OFFICE B", "ROOM", 1));
    e.push(dxfText(totalX / 4, 3 * totalY / 4, 0.4, "MEETING", "ROOM", 1));
    e.push(dxfText(3 * totalX / 4, 3 * totalY / 4, 0.4, "REST", "ROOM", 1));
  } else {
    // Small building
    addTable(e, 1, 1, 2, 1);
    addSofa(e, 3, 3);
    e.push(dxfText(totalX / 2, totalY / 2, 0.4, "OFFICE", "ROOM", 1));
  }

  // Grid axes with labels
  const xCoords = [0];
  for (const w of bxM) xCoords.push(xCoords[xCoords.length - 1] + w);
  const yCoords = [0];
  for (const w of byM) yCoords.push(yCoords[yCoords.length - 1] + w);

  for (const x of xCoords) {
    e.push(dxfLine(x, -3, x, totalY + 4, "GRID"));
    e.push(dxfText(x, -3.5, 0.5, String(xCoords.indexOf(x) + 1), "GRID", 1));
  }
  for (const y of yCoords) {
    e.push(dxfLine(-3, y, totalX + 4, y, "GRID"));
    e.push(dxfText(-3.5, y, 0.5, String.fromCharCode(65 + yCoords.indexOf(y)), "GRID", 2));
  }

  // Dimensions along X
  xAcc = 0;
  for (const w of bxM) {
    const x0 = xAcc;
    e.push(dxfLine(x0, -2, x0 + w, -2, "DIM"));
    e.push(dxfText(x0 + w / 2, -2.5, 0.35, String(Math.round(w * 1000)), "DIM", 1));
    xAcc += w;
  }

  // Title
  e.push(dxfText(totalX / 2, totalY + 4, 0.5, "1F FLOOR PLAN  1:100", "DIM", 1));

  return e;
}

function renderPortalFloorPlan(entry) {
  const model = entry.model;
  const e = [];
  const spanX = 18;         // portal frame span (X direction)
  const baySpacing = 6;      // longitudinal bay spacing (Y direction)
  const numBays = 4;         // number of longitudinal bays
  const totalY = baySpacing * numBays; // building length
  const wallT = 0.3;
  const off = 0.6;

  // Outer walls
  addWall(e, -off, -off, spanX + off, -off, wallT);
  addWall(e, -off, totalY + off, spanX + off, totalY + off, wallT);
  addWall(e, -off, -off, -off, totalY + off, wallT);
  addWall(e, spanX + off, -off, spanX + off, totalY + off, wallT);

  // Large industrial rolling doors on bottom wall
  addDoor(e, 2, -off, 5, 0);
  addDoor(e, 11, -off, 5, 0);

  // High windows along side walls (between column lines)
  for (let i = 0; i < numBays; i++) {
    const y0 = i * baySpacing + 1;
    const y1 = (i + 1) * baySpacing - 1;
    addWindow(e, spanX + off, y0, spanX + off, y1);
    addWindow(e, -off, y0, -off, y1);
  }

  // Columns at every grid intersection: 2 (span) x (numBays+1) (length)
  for (let yi = 0; yi <= numBays; yi++) {
    for (const cx of [0, spanX]) {
      const cy = yi * baySpacing;
      e.push(...dxfFilledRect(cx - 0.3, cy - 0.3, 0.6, 0.6, "COLUMN"));
    }
  }

  // Beams (rafters) along X at each frame line
  for (let yi = 0; yi <= numBays; yi++) {
    const cy = yi * baySpacing;
    e.push(dxfLine(0, cy, spanX, cy, "BEAM"));
  }

  // Purlins / girts between frames (longitudinal lines along Y)
  e.push(dxfLine(3, 0, 3, totalY, "BEAM"));
  e.push(dxfLine(9, 0, 9, totalY, "BEAM"));
  e.push(dxfLine(15, 0, 15, totalY, "BEAM"));

  // Crane rail lines
  e.push(dxfLine(4, off, 4, totalY - off, "FURN"));
  e.push(dxfLine(14, off, 14, totalY - off, "FURN"));
  e.push(dxfText(9, totalY / 2, 0.5, "10t CRANE", "ROOM", 1));

  // Industrial content
  addRect(e, 2, 2, 5, 4, "FURN");
  addRect(e, 2, baySpacing + 2, 4, 3, "FURN");
  addRect(e, 11, totalY - 6, 5, 4, "FURN");
  e.push(dxfCircle(9, 3, 1.2, "FURN"));

  // Office partition at far end
  addWall(e, off, totalY - 4, spanX / 2 - 1, totalY - 4, 0.12);
  addWall(e, spanX / 2 + 1, totalY - 4, spanX - off, totalY - 4, 0.12);
  addDoor(e, spanX / 2, totalY - 4, 1.2, 0);
  e.push(dxfText(spanX / 4, totalY - 2, 0.5, "OFFICE", "ROOM", 1));
  addTable(e, 2, totalY - 3.5, 2, 1);
  addSofa(e, 5, totalY - 3);

  // Grid axes
  const xGrids = [0, spanX];
  const xLabels = ["A", "B"];
  for (let i = 0; i < xGrids.length; i++) {
    e.push(dxfLine(xGrids[i], -3, xGrids[i], totalY + 4, "GRID"));
    e.push(dxfText(xGrids[i], -3.5, 0.5, xLabels[i], "GRID", 1));
  }
  for (let yi = 0; yi <= numBays; yi++) {
    const cy = yi * baySpacing;
    e.push(dxfLine(-3, cy, spanX + 4, cy, "GRID"));
    e.push(dxfText(-3.5, cy, 0.5, String(yi + 1), "GRID", 2));
  }

  // Dimensions
  e.push(dxfLine(0, -2, spanX, -2, "DIM"));
  e.push(dxfText(spanX / 2, -2.6, 0.4, "18000", "DIM", 1));
  for (let yi = 0; yi < numBays; yi++) {
    const y0 = yi * baySpacing;
    e.push(dxfLine(spanX + 2, y0, spanX + 2, y0 + baySpacing, "DIM"));
    e.push(dxfText(spanX + 3, y0 + baySpacing / 2, 0.35, "6000", "DIM", 0));
  }

  e.push(dxfText(spanX / 2, totalY + 4, 0.5, "GROUND FLOOR PLAN  1:100", "DIM", 1));

  return e;
}

// --- Main ---

const layers = [
  ["0", 7], ["COLUMN", 1], ["BEAM", 3], ["WALL", 7],
  ["DOOR", 3], ["WINDOW", 4], ["FURN", 8], ["STAIR", 6],
  ["GRID", 5], ["DIM", 5], ["ROOM", 4],
];

const renderers = {
  "frame-simple-1s1b": renderFrame1s1bFloor,
  "frame-complex-2s2b": renderFrame2s2bFloor,
  "frame3d-simple": render3dFloorPlan,
  "frame3d-complex": render3dFloorPlan,
  "frame3d-concrete": render3dFloorPlan,
  "portal-simple-18m": renderPortalFloorPlan,
};

for (const model of models) {
  const renderer = renderers[model.id];
  if (!renderer) continue;

  const entities = renderer(model);
  const dxf = buildDxf(entities, layers);
  const outPath = join(outDir, `arch-${model.id}.dxf`);
  writeFileSync(outPath, dxf, "utf-8");

  const lineCount = (dxf.match(/^LINE$/gm) || []).length;
  const textCount = (dxf.match(/^TEXT$/gm) || []).length;
  const circleCount = (dxf.match(/^CIRCLE$/gm) || []).length;
  const arcCount = (dxf.match(/^ARC$/gm) || []).length;
  console.log(`  arch-${model.id}.dxf: ${lineCount} lines, ${textCount} texts, ${circleCount} circles, ${arcCount} arcs`);
}

console.log(`\nGenerated architectural DXF files.`);
