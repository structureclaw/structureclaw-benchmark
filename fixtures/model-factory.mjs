#!/usr/bin/env node

// Generates 10 ground-truth structural models for reverse-engineering benchmarks.
// Output: tests/llm-benchmark/fixtures/ground-truth-models.json
// Usage: node tests/llm-benchmark/fixtures/model-factory.mjs

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "ground-truth-models.json");

// --- helpers ---

const pinned  = [true, true, true, true, true, false];
const roller  = [false, true, true, true, true, false];
const fixed   = [true, true, true, true, true, true];

function steel(id = "1") { return { id, name: "steel", E: 205000, nu: 0.3, rho: 7850 }; }
function beamSection(id = "1", name = "B1") {
  return { id, name, type: "beam", properties: { A: 0.01, Iy: 0.0001, Iz: 0.0001, J: 0.0001, G: 79000 } };
}
function rodSection(id = "1", name = "T1") {
  return { id, name, type: "rod", properties: { A: 0.01 } };
}

// --- models ---

const models = [];

// 1. beam-simple-6m: simply supported beam 6m, UDL 20kN/m
models.push({
  id: "beam-simple-6m",
  inferredType: "beam",
  description: "简支梁6m，均布荷载20kN/m",
  model: {
    schema_version: "2.0.0", unit_system: "SI",
    nodes: [
      { id: "1", x: 0, y: 0, z: 0, restraints: pinned },
      { id: "2", x: 3, y: 0, z: 0 },
      { id: "3", x: 6, y: 0, z: 0, restraints: roller },
    ],
    elements: [
      { id: "1", type: "beam", nodes: ["1", "2"], material: "1", section: "1" },
      { id: "2", type: "beam", nodes: ["2", "3"], material: "1", section: "1" },
    ],
    materials: [steel()],
    sections: [beamSection()],
    load_cases: [{ id: "LC1", type: "dead", loads: [
      { type: "distributed", element: "1", wz: -20, wy: 0 },
      { type: "distributed", element: "2", wz: -20, wy: 0 },
    ] }],
    load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
    metadata: { source: "ground-truth", inferredType: "beam", frameDimension: "2d" },
  },
});

// 2. beam-complex-12m: simply supported beam 12m, UDL 15kN/m + point load 50kN @ 4m
models.push({
  id: "beam-complex-12m",
  inferredType: "beam",
  description: "简支梁12m，均布荷载15kN/m，集中力50kN@4m",
  model: {
    schema_version: "2.0.0", unit_system: "SI",
    nodes: [
      { id: "1", x: 0, y: 0, z: 0, restraints: pinned },
      { id: "2", x: 4, y: 0, z: 0 },
      { id: "3", x: 6, y: 0, z: 0 },
      { id: "4", x: 12, y: 0, z: 0, restraints: roller },
    ],
    elements: [
      { id: "1", type: "beam", nodes: ["1", "2"], material: "1", section: "1" },
      { id: "2", type: "beam", nodes: ["2", "3"], material: "1", section: "1" },
      { id: "3", type: "beam", nodes: ["3", "4"], material: "1", section: "1" },
    ],
    materials: [steel()],
    sections: [beamSection()],
    load_cases: [{ id: "LC1", type: "dead", loads: [
      { type: "distributed", element: "1", wz: -15, wy: 0 },
      { type: "distributed", element: "2", wz: -15, wy: 0 },
      { type: "distributed", element: "3", wz: -15, wy: 0 },
      { node: "2", fz: -50 },
    ] }],
    load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
    metadata: { source: "ground-truth", inferredType: "beam", frameDimension: "2d" },
  },
});

// 3. frame-simple-1s1b: 1-story 1-bay steel frame
models.push({
  id: "frame-simple-1s1b",
  inferredType: "frame",
  description: "单层单跨钢框架，H=4.5m，L=6m",
  model: {
    schema_version: "2.0.0", unit_system: "SI",
    nodes: [
      { id: "N0_0", x: 0, y: 0, z: 0, restraints: fixed },
      { id: "N0_1", x: 6, y: 0, z: 0, restraints: fixed },
      { id: "N1_0", x: 0, y: 0, z: 4.5 },
      { id: "N1_1", x: 6, y: 0, z: 4.5 },
    ],
    elements: [
      { id: "C1", type: "column", nodes: ["N0_0", "N1_0"], material: "1", section: "1", story: "F1" },
      { id: "C2", type: "column", nodes: ["N0_1", "N1_1"], material: "1", section: "1", story: "F1" },
      { id: "B1", type: "beam", nodes: ["N1_0", "N1_1"], material: "1", section: "2", story: "F1" },
    ],
    materials: [steel()],
    sections: [
      { id: "1", name: "HW300x300", type: "H", purpose: "column",
        shape: { kind: "H", H: 0.3, B: 0.3, tw: 0.01, tf: 0.015 },
        properties: { A: 0.012, Iy: 0.0002, Iz: 0.0002, J: 0.00001, G: 79000 } },
      { id: "2", name: "HN400x200", type: "H", purpose: "beam",
        shape: { kind: "H", H: 0.4, B: 0.2, tw: 0.008, tf: 0.013 },
        properties: { A: 0.008, Iy: 0.0002, Iz: 0.00003, J: 0.000005, G: 79000 } },
    ],
    stories: [{ id: "F1", height: 4.5, floorLoad: 8 }],
    load_cases: [
      { id: "D", type: "dead", loads: [{ type: "distributed", element: "B1", wz: -8, wy: 0 }] },
    ],
    load_combinations: [{ id: "ULS", factors: { D: 1.0 } }],
    metadata: {
      source: "ground-truth", inferredType: "frame", frameDimension: "2d",
      storyCount: 1, bayCount: 1,
      geometry: { storyHeightsM: [4.5], bayWidthsM: [6] },
    },
  },
});

// 4. frame-complex-2s2b: 2-story 2-bay steel frame
models.push({
  id: "frame-complex-2s2b",
  inferredType: "frame",
  description: "2层2跨钢框架，层高3.6m，跨度5.4m+6m",
  model: {
    schema_version: "2.0.0", unit_system: "SI",
    nodes: [
      { id: "N0_0", x: 0, y: 0, z: 0, restraints: fixed },
      { id: "N0_1", x: 5.4, y: 0, z: 0, restraints: fixed },
      { id: "N0_2", x: 11.4, y: 0, z: 0, restraints: fixed },
      { id: "N1_0", x: 0, y: 0, z: 3.6, story: "F1" },
      { id: "N1_1", x: 5.4, y: 0, z: 3.6, story: "F1" },
      { id: "N1_2", x: 11.4, y: 0, z: 3.6, story: "F1" },
      { id: "N2_0", x: 0, y: 0, z: 7.2, story: "F2" },
      { id: "N2_1", x: 5.4, y: 0, z: 7.2, story: "F2" },
      { id: "N2_2", x: 11.4, y: 0, z: 7.2, story: "F2" },
    ],
    elements: [
      // F1 columns
      { id: "C1", type: "column", nodes: ["N0_0", "N1_0"], material: "1", section: "1", story: "F1" },
      { id: "C2", type: "column", nodes: ["N0_1", "N1_1"], material: "1", section: "1", story: "F1" },
      { id: "C3", type: "column", nodes: ["N0_2", "N1_2"], material: "1", section: "1", story: "F1" },
      // F2 columns
      { id: "C4", type: "column", nodes: ["N1_0", "N2_0"], material: "1", section: "1", story: "F2" },
      { id: "C5", type: "column", nodes: ["N1_1", "N2_1"], material: "1", section: "1", story: "F2" },
      { id: "C6", type: "column", nodes: ["N1_2", "N2_2"], material: "1", section: "1", story: "F2" },
      // F1 beams
      { id: "B1", type: "beam", nodes: ["N1_0", "N1_1"], material: "1", section: "2", story: "F1" },
      { id: "B2", type: "beam", nodes: ["N1_1", "N1_2"], material: "1", section: "2", story: "F1" },
      // F2 beams
      { id: "B3", type: "beam", nodes: ["N2_0", "N2_1"], material: "1", section: "2", story: "F2" },
      { id: "B4", type: "beam", nodes: ["N2_1", "N2_2"], material: "1", section: "2", story: "F2" },
    ],
    materials: [steel()],
    sections: [
      { id: "1", name: "HW350x350", type: "H", purpose: "column",
        shape: { kind: "H", H: 0.35, B: 0.35, tw: 0.012, tf: 0.019 },
        properties: { A: 0.017, Iy: 0.0004, Iz: 0.0004, J: 0.00002, G: 79000 } },
      { id: "2", name: "HN500x200", type: "H", purpose: "beam",
        shape: { kind: "H", H: 0.5, B: 0.2, tw: 0.01, tf: 0.016 },
        properties: { A: 0.011, Iy: 0.0004, Iz: 0.00004, J: 0.000008, G: 79000 } },
    ],
    stories: [
      { id: "F1", height: 3.6, floorLoad: 10 },
      { id: "F2", height: 3.6, floorLoad: 10 },
    ],
    load_cases: [
      { id: "D", type: "dead", loads: [
        { type: "distributed", element: "B1", wz: -10, wy: 0 },
        { type: "distributed", element: "B2", wz: -10, wy: 0 },
        { type: "distributed", element: "B3", wz: -10, wy: 0 },
        { type: "distributed", element: "B4", wz: -10, wy: 0 },
      ] },
      { id: "L", type: "live", loads: [
        { type: "distributed", element: "B1", wz: -8, wy: 0 },
        { type: "distributed", element: "B2", wz: -8, wy: 0 },
        { type: "distributed", element: "B3", wz: -8, wy: 0 },
        { type: "distributed", element: "B4", wz: -8, wy: 0 },
      ] },
    ],
    load_combinations: [{ id: "ULS", factors: { D: 1.2, L: 1.4 } }],
    metadata: {
      source: "ground-truth", inferredType: "frame", frameDimension: "2d",
      storyCount: 2, bayCount: 2,
      geometry: { storyHeightsM: [3.6, 3.6], bayWidthsM: [5.4, 6] },
    },
  },
});

// 5. truss-simple-tri: triangular truss, 5 panels, L=15m, H=2.5m
(() => {
  const L = 15, H = 2.5, panels = 5;
  const dx = L / panels;
  const nodes = [];
  const elements = [];
  // bottom chord nodes
  for (let i = 0; i <= panels; i++) nodes.push({ id: `B${i}`, x: i * dx, y: 0, z: 0, ...(i === 0 ? { restraints: fixed } : i === panels ? { restraints: roller } : {}) });
  // top chord nodes
  for (let i = 0; i <= panels; i++) nodes.push({ id: `T${i}`, x: i * dx, y: 0, z: H });
  // bottom chords
  for (let i = 0; i < panels; i++) elements.push({ id: `BC${i}`, type: "truss", nodes: [`B${i}`, `B${i + 1}`], material: "1", section: "1" });
  // top chords
  for (let i = 0; i < panels; i++) elements.push({ id: `TC${i}`, type: "truss", nodes: [`T${i}`, `T${i + 1}`], material: "1", section: "1" });
  // web members (verticals at every panel point + diagonals)
  for (let i = 0; i <= panels; i++) {
    elements.push({ id: `WV${i}`, type: "truss", nodes: [`B${i}`, `T${i}`], material: "1", section: "1" });
    if (i < panels) elements.push({ id: `WD${i}`, type: "truss", nodes: [`B${i + 1}`, `T${i}`], material: "1", section: "1" });
  }
  models.push({
    id: "truss-simple-tri",
    inferredType: "truss",
    description: "三角桁架，5节间，L=15m，H=2.5m，节点荷载10kN",
    model: {
      schema_version: "2.0.0", unit_system: "SI", nodes, elements,
      materials: [steel()], sections: [rodSection()],
      load_cases: [{ id: "LC1", type: "dead", loads: [
        { node: "B1", fz: -10 }, { node: "B2", fz: -10 }, { node: "B3", fz: -10 }, { node: "B4", fz: -10 },
      ] }],
      load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
      metadata: { source: "ground-truth", inferredType: "truss", frameDimension: "2d" },
    },
  });
})();

// 6. truss-complex-trap: trapezoidal truss, 6 panels, L=18m
(() => {
  const L = 18, He = 2.5, panels = 6;
  const dx = L / panels;
  const slope = 1 / 10;
  const nodes = [];
  const elements = [];
  // bottom chord
  for (let i = 0; i <= panels; i++) nodes.push({ id: `B${i}`, x: i * dx, y: 0, z: 0, ...(i === 0 ? { restraints: fixed } : i === panels ? { restraints: roller } : {}) });
  // top chord (with slope)
  for (let i = 0; i <= panels; i++) {
    const distFromCenter = Math.abs(i * dx - L / 2);
    const z = He - distFromCenter * slope;
    nodes.push({ id: `T${i}`, x: i * dx, y: 0, z });
  }
  // chords
  for (let i = 0; i < panels; i++) {
    elements.push({ id: `BC${i}`, type: "truss", nodes: [`B${i}`, `B${i + 1}`], material: "1", section: "1" });
    elements.push({ id: `TC${i}`, type: "truss", nodes: [`T${i}`, `T${i + 1}`], material: "1", section: "1" });
  }
  // web
  for (let i = 0; i <= panels; i++) {
    elements.push({ id: `WV${i}`, type: "truss", nodes: [`B${i}`, `T${i}`], material: "1", section: "1" });
    if (i < panels) elements.push({ id: `WD${i}`, type: "truss", nodes: [`B${i + 1}`, `T${i}`], material: "1", section: "1" });
  }
  models.push({
    id: "truss-complex-trap",
    inferredType: "truss",
    description: "梯形桁架，6节间，L=18m，H=2.5m，坡度1/10",
    model: {
      schema_version: "2.0.0", unit_system: "SI", nodes, elements,
      materials: [steel()], sections: [rodSection()],
      load_cases: [{ id: "LC1", type: "dead", loads: [
        { node: "B1", fz: -15 }, { node: "B2", fz: -15 }, { node: "B3", fz: -15 },
        { node: "B4", fz: -15 }, { node: "B5", fz: -15 },
      ] }],
      load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
      metadata: { source: "ground-truth", inferredType: "truss", frameDimension: "2d" },
    },
  });
})();

// 7. portal-simple-18m: portal frame L=18m, H=7m
models.push({
  id: "portal-simple-18m",
  inferredType: "portal-frame",
  description: "门式刚架，L=18m，H=7m，屋面荷载6kN/m",
  model: {
    schema_version: "2.0.0", unit_system: "SI",
    nodes: [
      { id: "1", x: 0, y: 0, z: 0, restraints: fixed },
      { id: "2", x: 18, y: 0, z: 0, restraints: fixed },
      { id: "3", x: 0, y: 0, z: 7 },
      { id: "4", x: 18, y: 0, z: 7 },
    ],
    elements: [
      { id: "1", type: "beam", nodes: ["1", "3"], material: "1", section: "1" },
      { id: "2", type: "beam", nodes: ["3", "4"], material: "1", section: "1" },
      { id: "3", type: "beam", nodes: ["4", "2"], material: "1", section: "1" },
    ],
    materials: [{ id: "1", name: "Q345", grade: "Q345", category: "steel", E: 206000, nu: 0.3, rho: 7850, fy: 345 }],
    sections: [{
      id: "1", name: "H600x250x10x16", type: "H",
      shape: { kind: "H", H: 0.6, B: 0.25, tw: 0.01, tf: 0.016 },
      properties: { A: 0.015, Iy: 0.0009, Iz: 0.0001, J: 0.000005, G: 79000 },
    }],
    load_cases: [{ id: "LC1", type: "dead", loads: [
      { type: "distributed", element: "2", wz: -6, wy: 0 },
    ] }],
    load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
    metadata: { source: "ground-truth", inferredType: "portal-frame", frameDimension: "2d" },
  },
});

// 8. portal-complex-ds: double-span portal frame, 2x18m, H=9m
models.push({
  id: "portal-complex-ds",
  inferredType: "portal-frame",
  description: "双跨门式刚架，2x18m，H=9m，屋面荷载6kN/m",
  model: {
    schema_version: "2.0.0", unit_system: "SI",
    nodes: [
      { id: "1", x: 0, y: 0, z: 0, restraints: fixed },
      { id: "2", x: 18, y: 0, z: 0, restraints: fixed },
      { id: "3", x: 36, y: 0, z: 0, restraints: fixed },
      { id: "4", x: 0, y: 0, z: 9 },
      { id: "5", x: 18, y: 0, z: 9 },
      { id: "6", x: 36, y: 0, z: 9 },
    ],
    elements: [
      { id: "1", type: "beam", nodes: ["1", "4"], material: "1", section: "1" },
      { id: "2", type: "beam", nodes: ["4", "5"], material: "1", section: "1" },
      { id: "3", type: "beam", nodes: ["5", "6"], material: "1", section: "1" },
      { id: "4", type: "beam", nodes: ["6", "3"], material: "1", section: "1" },
      { id: "5", type: "beam", nodes: ["5", "2"], material: "1", section: "1" },
    ],
    materials: [{ id: "1", name: "Q345", grade: "Q345", category: "steel", E: 206000, nu: 0.3, rho: 7850, fy: 345 }],
    sections: [{
      id: "1", name: "H700x300x12x20", type: "H",
      shape: { kind: "H", H: 0.7, B: 0.3, tw: 0.012, tf: 0.02 },
      properties: { A: 0.022, Iy: 0.0015, Iz: 0.0002, J: 0.00001, G: 79000 },
    }],
    load_cases: [{ id: "LC1", type: "dead", loads: [
      { type: "distributed", element: "2", wz: -6, wy: 0 },
      { type: "distributed", element: "3", wz: -6, wy: 0 },
    ] }],
    load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
    metadata: { source: "ground-truth", inferredType: "portal-frame", frameDimension: "2d" },
  },
});

// 9. dspan-simple-5-6: double-span beam 5m+6m
models.push({
  id: "dspan-simple-5-6",
  inferredType: "double-span-beam",
  description: "双跨连续梁5m+6m，均布荷载12kN/m",
  model: {
    schema_version: "2.0.0", unit_system: "SI",
    nodes: [
      { id: "1", x: 0, y: 0, z: 0, restraints: pinned },
      { id: "2", x: 5, y: 0, z: 0 },
      { id: "3", x: 11, y: 0, z: 0, restraints: roller },
    ],
    elements: [
      { id: "1", type: "beam", nodes: ["1", "2"], material: "1", section: "1" },
      { id: "2", type: "beam", nodes: ["2", "3"], material: "1", section: "1" },
    ],
    materials: [steel()],
    sections: [beamSection()],
    load_cases: [{ id: "LC1", type: "dead", loads: [
      { type: "distributed", element: "1", wz: -12, wy: 0 },
      { type: "distributed", element: "2", wz: -12, wy: 0 },
    ] }],
    load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
    metadata: { source: "ground-truth", inferredType: "double-span-beam", frameDimension: "2d" },
  },
});

// 10. dspan-complex-3span: three-span continuous beam 4m+5m+4m
models.push({
  id: "dspan-complex-3span",
  inferredType: "double-span-beam",
  description: "三跨连续梁4m+5m+4m，均布荷载15kN/m",
  model: {
    schema_version: "2.0.0", unit_system: "SI",
    nodes: [
      { id: "1", x: 0, y: 0, z: 0, restraints: pinned },
      { id: "2", x: 4, y: 0, z: 0 },
      { id: "3", x: 9, y: 0, z: 0 },
      { id: "4", x: 13, y: 0, z: 0, restraints: roller },
    ],
    elements: [
      { id: "1", type: "beam", nodes: ["1", "2"], material: "1", section: "1" },
      { id: "2", type: "beam", nodes: ["2", "3"], material: "1", section: "1" },
      { id: "3", type: "beam", nodes: ["3", "4"], material: "1", section: "1" },
    ],
    materials: [steel()],
    sections: [beamSection()],
    load_cases: [{ id: "LC1", type: "dead", loads: [
      { type: "distributed", element: "1", wz: -15, wy: 0 },
      { type: "distributed", element: "2", wz: -15, wy: 0 },
      { type: "distributed", element: "3", wz: -15, wy: 0 },
    ] }],
    load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
    metadata: { source: "ground-truth", inferredType: "double-span-beam", frameDimension: "2d" },
  },
});

// --- 3D frame models ---

// Helper: generate a 3D frame with given bay/story layout
function build3dFrame(id, description, opts) {
  const { bayWidthsX, bayWidthsY, storyHeights, floorLoads, material, sections } = opts;
  const xCoords = [0];
  for (const w of bayWidthsX) xCoords.push(xCoords[xCoords.length - 1] + w);
  const yCoords = [0];
  for (const w of bayWidthsY) yCoords.push(yCoords[yCoords.length - 1] + w);
  const zCoords = [0];
  for (const h of storyHeights) zCoords.push(zCoords[zCoords.length - 1] + h);

  const nodes = [];
  const elements = [];
  const loads = [];
  let eid = 1;

  // Nodes
  for (let si = 0; si < zCoords.length; si++) {
    for (let xi = 0; xi < xCoords.length; xi++) {
      for (let yi = 0; yi < yCoords.length; yi++) {
        const node = {
          id: `N${si}_${xi}_${yi}`,
          x: xCoords[xi],
          y: yCoords[yi],
          z: zCoords[si],
        };
        if (si === 0) node.restraints = fixed;
        nodes.push(node);
      }
    }
  }

  // Columns
  for (let si = 1; si < zCoords.length; si++) {
    for (let xi = 0; xi < xCoords.length; xi++) {
      for (let yi = 0; yi < yCoords.length; yi++) {
        elements.push({
          id: `C${eid++}`,
          type: "column",
          nodes: [`N${si - 1}_${xi}_${yi}`, `N${si}_${xi}_${yi}`],
          material: "1",
          section: "1",
          story: `F${si}`,
        });
      }
    }
  }

  // X-direction beams
  for (let si = 1; si < zCoords.length; si++) {
    for (let xi = 0; xi < bayWidthsX.length; xi++) {
      for (let yi = 0; yi < yCoords.length; yi++) {
        elements.push({
          id: `BX${eid++}`,
          type: "beam",
          nodes: [`N${si}_${xi}_${yi}`, `N${si}_${xi + 1}_${yi}`],
          material: "1",
          section: "2",
          story: `F${si}`,
        });
      }
    }
  }

  // Y-direction beams
  for (let si = 1; si < zCoords.length; si++) {
    for (let xi = 0; xi < xCoords.length; xi++) {
      for (let yi = 0; yi < bayWidthsY.length; yi++) {
        elements.push({
          id: `BY${eid++}`,
          type: "beam",
          nodes: [`N${si}_${xi}_${yi}`, `N${si}_${xi}_${yi + 1}`],
          material: "1",
          section: "2",
          story: `F${si}`,
        });
      }
    }
  }

  // Floor loads as distributed loads on X-direction beams
  for (const fl of floorLoads) {
    const si = fl.storyIndex;
    const wPerBeam = fl.loadPerArea;
    for (let xi = 0; xi < bayWidthsX.length; xi++) {
      for (let yi = 0; yi < yCoords.length; yi++) {
        const beamId = `BX${bayWidthsX.length * yCoords.length * (si - 1) + xi * yCoords.length + yi + (xCoords.length - bayWidthsX.length) * yCoords.length * (si - 1) + 1}`;
        // Find the actual beam element
        const beamEl = elements.find(e =>
          e.nodes[0] === `N${si}_${xi}_${yi}` && e.nodes[1] === `N${si}_${xi + 1}_${yi}`
        );
        if (beamEl) {
          loads.push({ type: "distributed", element: beamEl.id, wz: -wPerBeam, wy: 0 });
        }
      }
    }
  }

  const stories = storyHeights.map((h, i) => ({
    id: `F${i + 1}`,
    height: h,
    floorLoad: floorLoads.find(fl => fl.storyIndex === i + 1)?.loadPerArea || 0,
  }));

  return {
    id,
    inferredType: "frame",
    description,
    model: {
      schema_version: "2.0.0",
      unit_system: "SI",
      nodes,
      elements,
      materials: [material],
      sections,
      stories,
      load_cases: [{ id: "D", type: "dead", loads }],
      load_combinations: [{ id: "ULS", factors: { D: 1.2 } }],
      metadata: {
        source: "ground-truth",
        inferredType: "frame",
        frameDimension: "3d",
        storyCount: storyHeights.length,
        bayCountX: bayWidthsX.length,
        bayCountY: bayWidthsY.length,
        geometry: { storyHeightsM: storyHeights, bayWidthsXM: bayWidthsX, bayWidthsYM: bayWidthsY },
      },
    },
  };
}

// 11. frame3d-simple: 2-story, X: 1 bay 6m, Y: 1 bay 5m
models.push(build3dFrame("frame3d-simple", "2层空间钢框架，X向1跨6m，Y向1跨5m，层高3.6m", {
  bayWidthsX: [6],
  bayWidthsY: [5],
  storyHeights: [3.6, 3.6],
  floorLoads: [
    { storyIndex: 1, loadPerArea: 10 },
    { storyIndex: 2, loadPerArea: 10 },
  ],
  material: { id: "1", name: "Q345", grade: "Q345", category: "steel", E: 206000, nu: 0.3, rho: 7850, fy: 345 },
  sections: [
    {
      id: "1", name: "HW350x350", type: "H", purpose: "column",
      shape: { kind: "H", H: 0.35, B: 0.35, tw: 0.012, tf: 0.019 },
      properties: { A: 0.017, Iy: 0.0004, Iz: 0.0004, J: 0.00002, G: 79000 },
    },
    {
      id: "2", name: "HN500x200", type: "H", purpose: "beam",
      shape: { kind: "H", H: 0.5, B: 0.2, tw: 0.01, tf: 0.016 },
      properties: { A: 0.011, Iy: 0.0004, Iz: 0.00004, J: 0.000008, G: 79000 },
    },
  ],
}));

// 12. frame3d-complex: 2-story, X: 2 bays 6m+6m, Y: 2 bays 5m+5m
models.push(build3dFrame("frame3d-complex", "2层空间钢框架，X向2跨6m+6m，Y向2跨5m+5m，层高3.6m", {
  bayWidthsX: [6, 6],
  bayWidthsY: [5, 5],
  storyHeights: [3.6, 3.6],
  floorLoads: [
    { storyIndex: 1, loadPerArea: 10 },
    { storyIndex: 2, loadPerArea: 8 },
  ],
  material: { id: "1", name: "Q345", grade: "Q345", category: "steel", E: 206000, nu: 0.3, rho: 7850, fy: 345 },
  sections: [
    {
      id: "1", name: "HW400x400", type: "H", purpose: "column",
      shape: { kind: "H", H: 0.4, B: 0.4, tw: 0.013, tf: 0.021 },
      properties: { A: 0.021, Iy: 0.0006, Iz: 0.0006, J: 0.00003, G: 79000 },
    },
    {
      id: "2", name: "HN600x200", type: "H", purpose: "beam",
      shape: { kind: "H", H: 0.6, B: 0.2, tw: 0.011, tf: 0.017 },
      properties: { A: 0.013, Iy: 0.0007, Iz: 0.00005, J: 0.000009, G: 79000 },
    },
  ],
}));

// 13. frame3d-concrete: 2-story concrete, X: 2 bays 6m+6m, Y: 1 bay 5m
models.push(build3dFrame("frame3d-concrete", "2层3D混凝土框架，X向2跨6m+6m，Y向1跨5m，层高3.6m", {
  bayWidthsX: [6, 6],
  bayWidthsY: [5],
  storyHeights: [3.6, 3.6],
  floorLoads: [
    { storyIndex: 1, loadPerArea: 12 },
    { storyIndex: 2, loadPerArea: 10 },
  ],
  material: { id: "1", name: "C30", grade: "C30", category: "concrete", E: 30000, nu: 0.2, rho: 2500, fc: 14.3 },
  sections: [
    {
      id: "1", name: "C30 500x500", type: "rect", purpose: "column",
      shape: { kind: "rect", H: 0.5, B: 0.5 },
      properties: { A: 0.25, Iy: 0.0052, Iz: 0.0052, J: 0.0087, G: 12500 },
    },
    {
      id: "2", name: "C30 300x600", type: "rect", purpose: "beam",
      shape: { kind: "rect", H: 0.6, B: 0.3 },
      properties: { A: 0.18, Iy: 0.0054, Iz: 0.00135, J: 0.00224, G: 12500 },
    },
  ],
}));

// --- write output ---
writeFileSync(OUT, JSON.stringify(models, null, 2));
console.log(`Generated ${models.length} ground-truth models → ${OUT}`);
for (const m of models) {
  const n = m.model.nodes.length;
  const e = m.model.elements.length;
  console.log(`  ${m.id}: ${m.inferredType}, ${n} nodes, ${e} elements`);
}
