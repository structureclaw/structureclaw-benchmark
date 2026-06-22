#!/usr/bin/env node

// Generates ground-truth structural models for benchmark model-match assertions.
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
  description: "单层单跨钢框架，H=4.5m，L=6m，屋面梁线荷载48kN/m",
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
    stories: [{ id: "F1", height: 4.5, floorLoad: 8, floorLoadUnit: "kN/m2", equivalentLineLoad: 48 }],
    load_cases: [
      { id: "D", type: "dead", loads: [{ type: "distributed", element: "B1", wz: -48, wy: 0 }] },
    ],
    load_combinations: [{ id: "ULS", factors: { D: 1.0 } }],
    metadata: {
      source: "ground-truth", inferredType: "frame", frameDimension: "2d",
      floorLoadUnit: "kN/m2",
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

// 5. truss-simple-tri: parallel-chord truss with triangular web, 5 panels, L=15m, H=2.5m
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
    description: "平行弦三角腹杆桁架，5节间，L=15m，H=2.5m，下弦节点荷载10kN",
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

// 5b. truss-pratt-15m-top10: Pratt-like truss, top chord nodal loads
(() => {
  const L = 15, H = 2.5, panels = 5;
  const dx = L / panels;
  const nodes = [];
  const elements = [];
  for (let i = 0; i <= panels; i++) nodes.push({ id: `B${i}`, x: i * dx, y: 0, z: 0, ...(i === 0 ? { restraints: fixed } : i === panels ? { restraints: roller } : {}) });
  for (let i = 0; i <= panels; i++) nodes.push({ id: `T${i}`, x: i * dx, y: 0, z: H });
  for (let i = 0; i < panels; i++) {
    elements.push({ id: `BC${i}`, type: "truss", nodes: [`B${i}`, `B${i + 1}`], material: "1", section: "1" });
    elements.push({ id: `TC${i}`, type: "truss", nodes: [`T${i}`, `T${i + 1}`], material: "1", section: "1" });
  }
  for (let i = 0; i <= panels; i++) {
    elements.push({ id: `WV${i}`, type: "truss", nodes: [`B${i}`, `T${i}`], material: "1", section: "1" });
  }
  for (let i = 0; i < panels; i++) {
    const diagonalNodes = i < panels / 2 ? [`B${i}`, `T${i + 1}`] : [`T${i}`, `B${i + 1}`];
    elements.push({ id: `WD${i}`, type: "truss", nodes: diagonalNodes, material: "1", section: "1" });
  }
  models.push({
    id: "truss-pratt-15m-top10",
    inferredType: "truss",
    description: "Pratt桁架，5节间，L=15m，H=2.5m，上弦节点荷载10kN",
    model: {
      schema_version: "2.0.0", unit_system: "SI", nodes, elements,
      materials: [steel()], sections: [rodSection()],
      load_cases: [{ id: "LC1", type: "dead", loads: [
        { node: "T1", fz: -10 }, { node: "T2", fz: -10 }, { node: "T3", fz: -10 }, { node: "T4", fz: -10 },
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
      { id: "2", x: 5, y: 0, z: 0, restraints: roller },
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
      { id: "2", x: 4, y: 0, z: 0, restraints: roller },
      { id: "3", x: 9, y: 0, z: 0, restraints: roller },
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

  // Floor area loads are represented as equivalent line loads on X-direction beams.
  const totalSpanX = xCoords[xCoords.length - 1];
  const totalSpanY = yCoords[yCoords.length - 1];
  const xBeamLengthPerStory = totalSpanX * yCoords.length;
  for (const fl of floorLoads) {
    const si = fl.storyIndex;
    const totalFloorLoad = fl.loadPerArea * totalSpanX * totalSpanY;
    const wPerBeam = xBeamLengthPerStory > 0 ? totalFloorLoad / xBeamLengthPerStory : fl.loadPerArea;
    for (let xi = 0; xi < bayWidthsX.length; xi++) {
      for (let yi = 0; yi < yCoords.length; yi++) {
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
    floorLoadUnit: "kN/m2",
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
        floorLoadUnit: "kN/m2",
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

// --- additional standard-workflow models ---

function q345(id = "1") {
  return { id, name: "Q345", grade: "Q345", category: "steel", E: 206000, nu: 0.3, rho: 7850, fy: 345 };
}

function concrete(id = "1", grade = "C30") {
  return {
    id,
    name: grade,
    grade,
    category: "concrete",
    E: grade === "C35" ? 31500 : 30000,
    nu: 0.2,
    rho: 2500,
    fc: grade === "C35" ? 16.7 : 14.3,
  };
}

function hSection(id, name, purpose = "beam") {
  return {
    id,
    name,
    type: "H",
    purpose,
    shape: { kind: "H", H: 0.35, B: 0.25, tw: 0.01, tf: 0.016 },
    properties: { A: 0.012, Iy: 0.0003, Iz: 0.00008, J: 0.00001, G: 79000 },
  };
}

function rectSection(id, name, width, depth, purpose = "beam") {
  return {
    id,
    name,
    type: "rect",
    purpose,
    shape: { kind: "rect", B: width, H: depth },
    properties: {
      A: width * depth,
      Iy: width * depth ** 3 / 12,
      Iz: depth * width ** 3 / 12,
      J: width * depth * (width ** 2 + depth ** 2) / 12,
      G: 12500,
    },
  };
}

function uniqueSorted(values) {
  return [...new Set(values.map((value) => Number(value.toFixed(6))))].sort((a, b) => a - b);
}

function buildBeamModel(id, description, opts) {
  const {
    inferredType = "beam",
    supportPositions,
    endPosition,
    restraintsByX = {},
    udl = null,
    pointLoads = [],
    material = steel(),
    section = beamSection(),
  } = opts;
  const pointPositions = pointLoads.map((load) => load.x);
  const isSingleSpanSimpleUdl = udl !== null
    && supportPositions.length === 2
    && supportPositions.includes(0)
    && supportPositions.includes(endPosition);
  const positions = uniqueSorted([
    0,
    endPosition,
    ...supportPositions,
    ...pointPositions,
    ...(isSingleSpanSimpleUdl ? [endPosition / 2] : []),
  ]);
  const nodes = positions.map((x, index) => {
    const node = { id: `N${index + 1}`, x, y: 0, z: 0 };
    const restraint = restraintsByX[x];
    if (restraint) node.restraints = restraint;
    return node;
  });
  const elements = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    elements.push({ id: `E${i + 1}`, type: "beam", nodes: [nodes[i].id, nodes[i + 1].id], material: "1", section: "1" });
  }
  const loads = [];
  if (udl !== null) {
    for (const element of elements) loads.push({ type: "distributed", element: element.id, wz: -udl, wy: 0 });
  }
  for (const load of pointLoads) {
    const node = nodes.find((item) => item.x === load.x);
    if (node) loads.push({ node: node.id, fz: -load.fz });
  }
  return {
    id,
    inferredType,
    description,
    model: {
      schema_version: "2.0.0",
      unit_system: "SI",
      nodes,
      elements,
      materials: [material],
      sections: [section],
      load_cases: [{ id: "LC1", type: "dead", loads }],
      load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
      metadata: { source: "ground-truth", inferredType, frameDimension: "2d" },
    },
  };
}

function build2dFrame(id, description, opts) {
  const {
    inferredType = "frame",
    bayWidths,
    storyHeights,
    floorLoads = [],
    floorLoadUnit = "line",
    tributaryWidthM,
    lateralLoads = [],
    pointLoads = [],
    material = q345(),
    sections = [hSection("1", "HW350x350", "column"), hSection("2", "HN500x200", "beam")],
  } = opts;
  const xCoords = [0];
  for (const width of bayWidths) xCoords.push(xCoords[xCoords.length - 1] + width);
  const zCoords = [0];
  for (const height of storyHeights) zCoords.push(zCoords[zCoords.length - 1] + height);
  const totalSpan = xCoords[xCoords.length - 1];
  const effectiveTributaryWidth = tributaryWidthM ?? totalSpan;
  const toEquivalentLineLoad = (floorLoad) => (
    floorLoadUnit === "area" ? floorLoad * effectiveTributaryWidth : floorLoad
  );
  const nodes = [];
  const elements = [];
  const loads = [];

  for (let si = 0; si < zCoords.length; si++) {
    for (let xi = 0; xi < xCoords.length; xi++) {
      const node = { id: `N${si}_${xi}`, x: xCoords[xi], y: 0, z: zCoords[si] };
      if (si === 0) node.restraints = fixed;
      nodes.push(node);
    }
  }

  for (let si = 1; si < zCoords.length; si++) {
    for (let xi = 0; xi < xCoords.length; xi++) {
      elements.push({
        id: `C${si}_${xi}`,
        type: "column",
        nodes: [`N${si - 1}_${xi}`, `N${si}_${xi}`],
        material: "1",
        section: "1",
        story: `F${si}`,
      });
    }
    for (let xi = 0; xi < bayWidths.length; xi++) {
      const beam = {
        id: `B${si}_${xi}`,
        type: "beam",
        nodes: [`N${si}_${xi}`, `N${si}_${xi + 1}`],
        material: "1",
        section: "2",
        story: `F${si}`,
      };
      elements.push(beam);
      const floorLoad = floorLoads[si - 1] ?? 0;
      if (floorLoad > 0) loads.push({ type: "distributed", element: beam.id, wz: -toEquivalentLineLoad(floorLoad), wy: 0 });
    }
  }

  for (const load of lateralLoads) {
    for (const xi of load.xIndices || [xCoords.length - 1]) {
      loads.push({ node: `N${load.storyIndex}_${xi}`, fx: load.fx });
    }
  }
  for (const load of pointLoads) {
    const nodeLoad = { node: `N${load.storyIndex}_${load.xIndex}` };
    for (const key of ["fx", "fy", "fz"]) {
      if (Number.isFinite(Number(load[key]))) nodeLoad[key] = load[key];
    }
    loads.push(nodeLoad);
  }

  const stories = storyHeights.map((height, index) => {
    const floorLoad = floorLoads[index] ?? 0;
    return {
      id: `F${index + 1}`,
      height,
      floorLoad,
      floorLoadUnit: floorLoadUnit === "area" ? "kN/m2" : "kN/m",
      ...(floorLoadUnit === "area" ? { tributaryWidthM: effectiveTributaryWidth, equivalentLineLoad: toEquivalentLineLoad(floorLoad) } : {}),
    };
  });

  return {
    id,
    inferredType,
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
      load_combinations: [{ id: "ULS", factors: { D: 1.0 } }],
      metadata: {
        source: "ground-truth",
        inferredType,
        frameDimension: "2d",
        storyCount: storyHeights.length,
        bayCount: bayWidths.length,
        floorLoadUnit: floorLoadUnit === "area" ? "kN/m2" : "kN/m",
        ...(floorLoadUnit === "area" ? { tributaryWidthM: effectiveTributaryWidth } : {}),
        geometry: { storyHeightsM: storyHeights, bayWidthsM: bayWidths },
      },
    },
  };
}

function buildColumn(id, description, opts) {
  const { inferredType = "column", height, axial = 0, lateral = 0, material, section } = opts;
  const loads = [];
  if (axial) loads.push({ node: "N2", fz: -axial });
  if (lateral) loads.push({ node: "N2", fx: lateral });
  return {
    id,
    inferredType,
    description,
    model: {
      schema_version: "2.0.0",
      unit_system: "SI",
      nodes: [
        { id: "N1", x: 0, y: 0, z: 0, restraints: fixed },
        { id: "N2", x: 0, y: 0, z: height },
      ],
      elements: [{ id: "C1", type: "column", nodes: ["N1", "N2"], material: "1", section: "1" }],
      materials: [material],
      sections: [section],
      load_cases: [{ id: "LC1", type: "dead", loads }],
      load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
      metadata: { source: "ground-truth", inferredType, frameDimension: "2d" },
    },
  };
}

function buildPortalSingle(id, description, opts) {
  const { span, height, roofLoad, material = q345(), section = hSection("1", "H600x250", "portal") } = opts;
  return {
    id,
    inferredType: "portal-frame",
    description,
    model: {
      schema_version: "2.0.0",
      unit_system: "SI",
      nodes: [
        { id: "N1", x: 0, y: 0, z: 0, restraints: fixed },
        { id: "N2", x: span, y: 0, z: 0, restraints: fixed },
        { id: "N3", x: 0, y: 0, z: height },
        { id: "N4", x: span, y: 0, z: height },
      ],
      elements: [
        { id: "C1", type: "column", nodes: ["N1", "N3"], material: "1", section: "1" },
        { id: "R1", type: "beam", nodes: ["N3", "N4"], material: "1", section: "1" },
        { id: "C2", type: "column", nodes: ["N4", "N2"], material: "1", section: "1" },
      ],
      materials: [material],
      sections: [section],
      load_cases: [{ id: "LC1", type: "dead", loads: [{ type: "distributed", element: "R1", wz: -roofLoad, wy: 0 }] }],
      load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
      metadata: { source: "ground-truth", inferredType: "portal-frame", frameDimension: "2d" },
    },
  };
}

function buildPortalDouble(id, description, opts) {
  const { span = 18, height, roofLoad, craneTons = 0 } = opts;
  const craneLoad = craneTons > 0 ? craneTons * 9.8 : 0;
  const loads = [
    { type: "distributed", element: "R1", wz: -roofLoad, wy: 0 },
    { type: "distributed", element: "R2", wz: -roofLoad, wy: 0 },
  ];
  if (craneLoad) {
    loads.push({ node: "N5", fz: -craneLoad, fx: craneLoad * 0.1 });
  }
  return {
    id,
    inferredType: "portal-frame",
    description,
    model: {
      schema_version: "2.0.0",
      unit_system: "SI",
      nodes: [
        { id: "N1", x: 0, y: 0, z: 0, restraints: fixed },
        { id: "N2", x: span, y: 0, z: 0, restraints: fixed },
        { id: "N3", x: span * 2, y: 0, z: 0, restraints: fixed },
        { id: "N4", x: 0, y: 0, z: height },
        { id: "N5", x: span, y: 0, z: height },
        { id: "N6", x: span * 2, y: 0, z: height },
      ],
      elements: [
        { id: "C1", type: "column", nodes: ["N1", "N4"], material: "1", section: "1" },
        { id: "R1", type: "beam", nodes: ["N4", "N5"], material: "1", section: "1" },
        { id: "R2", type: "beam", nodes: ["N5", "N6"], material: "1", section: "1" },
        { id: "C2", type: "column", nodes: ["N6", "N3"], material: "1", section: "1" },
        { id: "C3", type: "column", nodes: ["N5", "N2"], material: "1", section: "1" },
      ],
      materials: [q345()],
      sections: [hSection("1", "H700x300", "portal")],
      load_cases: [{ id: "LC1", type: "dead", loads }],
      load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
      metadata: { source: "ground-truth", inferredType: "portal-frame", frameDimension: "2d" },
    },
  };
}

function buildMezzaninePortal() {
  return {
    id: "portal-mezzanine-18m-7m",
    inferredType: "portal-frame",
    description: "18m门式刚架，一侧3m夹层，屋面荷载6kN/m，夹层荷载4kN/m2",
    model: {
      schema_version: "2.0.0",
      unit_system: "SI",
      nodes: [
        { id: "N1", x: 0, y: 0, z: 0, restraints: fixed },
        { id: "N2", x: 18, y: 0, z: 0, restraints: fixed },
        { id: "N3", x: 0, y: 0, z: 3 },
        { id: "N4", x: 6, y: 0, z: 3 },
        { id: "N5", x: 0, y: 0, z: 7 },
        { id: "N6", x: 18, y: 0, z: 7 },
      ],
      elements: [
        { id: "C1a", type: "column", nodes: ["N1", "N3"], material: "1", section: "1" },
        { id: "C1b", type: "column", nodes: ["N3", "N5"], material: "1", section: "1" },
        { id: "M1", type: "beam", nodes: ["N3", "N4"], material: "1", section: "1" },
        { id: "R1", type: "beam", nodes: ["N5", "N6"], material: "1", section: "1" },
        { id: "C2", type: "column", nodes: ["N6", "N2"], material: "1", section: "1" },
      ],
      materials: [q345()],
      sections: [hSection("1", "H600x250", "portal")],
      load_cases: [{ id: "LC1", type: "dead", loads: [
        { type: "distributed", element: "R1", wz: -6, wy: 0 },
        { type: "distributed", element: "M1", wz: -4, wy: 0 },
      ] }],
      load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
      metadata: { source: "ground-truth", inferredType: "portal-frame", frameDimension: "2d" },
    },
  };
}

function buildPanelTruss(id, description, opts) {
  const { span, height, panels, nodeLoad, loadChord = "top", inferredType = "truss" } = opts;
  const dx = span / panels;
  const nodes = [];
  const elements = [];
  for (let i = 0; i <= panels; i++) {
    nodes.push({ id: `B${i}`, x: i * dx, y: 0, z: 0, ...(i === 0 ? { restraints: fixed } : i === panels ? { restraints: roller } : {}) });
    nodes.push({ id: `T${i}`, x: i * dx, y: 0, z: height });
  }
  for (let i = 0; i < panels; i++) {
    elements.push({ id: `BC${i}`, type: "truss", nodes: [`B${i}`, `B${i + 1}`], material: "1", section: "1" });
    elements.push({ id: `TC${i}`, type: "truss", nodes: [`T${i}`, `T${i + 1}`], material: "1", section: "1" });
    elements.push({ id: `D${i}`, type: "truss", nodes: [i % 2 === 0 ? `B${i}` : `T${i}`, i % 2 === 0 ? `T${i + 1}` : `B${i + 1}`], material: "1", section: "1" });
  }
  const loads = [];
  for (let i = 1; i < panels; i++) {
    loads.push({ node: `${loadChord === "top" ? "T" : "B"}${i}`, fz: -nodeLoad });
  }
  return {
    id,
    inferredType,
    description,
    model: {
      schema_version: "2.0.0",
      unit_system: "SI",
      nodes,
      elements,
      materials: [steel()],
      sections: [rodSection()],
      load_cases: [{ id: "LC1", type: "dead", loads }],
      load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
      metadata: { source: "ground-truth", inferredType, frameDimension: "2d" },
    },
  };
}

function buildTrapezoidTruss(id, description, opts) {
  const { span, height, panels, nodeLoad, loadChord = "bottom" } = opts;
  const dx = span / panels;
  const slope = 1 / 10;
  const nodes = [];
  const elements = [];
  for (let i = 0; i <= panels; i++) {
    nodes.push({ id: `B${i}`, x: i * dx, y: 0, z: 0, ...(i === 0 ? { restraints: fixed } : i === panels ? { restraints: roller } : {}) });
  }
  for (let i = 0; i <= panels; i++) {
    const distFromCenter = Math.abs(i * dx - span / 2);
    nodes.push({ id: `T${i}`, x: i * dx, y: 0, z: height - distFromCenter * slope });
  }
  for (let i = 0; i < panels; i++) {
    elements.push({ id: `BC${i}`, type: "truss", nodes: [`B${i}`, `B${i + 1}`], material: "1", section: "1" });
    elements.push({ id: `TC${i}`, type: "truss", nodes: [`T${i}`, `T${i + 1}`], material: "1", section: "1" });
  }
  for (let i = 0; i <= panels; i++) {
    elements.push({ id: `WV${i}`, type: "truss", nodes: [`B${i}`, `T${i}`], material: "1", section: "1" });
    if (i < panels) elements.push({ id: `WD${i}`, type: "truss", nodes: [`B${i + 1}`, `T${i}`], material: "1", section: "1" });
  }
  const loads = [];
  for (let i = 1; i < panels; i++) {
    loads.push({ node: `${loadChord === "top" ? "T" : "B"}${i}`, fz: -nodeLoad });
  }
  return {
    id,
    inferredType: "truss",
    description,
    model: {
      schema_version: "2.0.0",
      unit_system: "SI",
      nodes,
      elements,
      materials: [steel()],
      sections: [rodSection()],
      load_cases: [{ id: "LC1", type: "dead", loads }],
      load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
      metadata: { source: "ground-truth", inferredType: "truss", frameDimension: "2d" },
    },
  };
}

function buildTriangularTruss12() {
  return {
    id: "truss-triangle-12m-3m-20k",
    inferredType: "truss",
    description: "三角桁架，跨度12m，高3m，节点荷载20kN",
    model: {
      schema_version: "2.0.0",
      unit_system: "SI",
      nodes: [
        { id: "B0", x: 0, y: 0, z: 0, restraints: fixed },
        { id: "B1", x: 6, y: 0, z: 0 },
        { id: "B2", x: 12, y: 0, z: 0, restraints: roller },
        { id: "T0", x: 3, y: 0, z: 1.5 },
        { id: "T1", x: 6, y: 0, z: 3 },
        { id: "T2", x: 9, y: 0, z: 1.5 },
      ],
      elements: [
        { id: "BC1", type: "truss", nodes: ["B0", "B1"], material: "1", section: "1" },
        { id: "BC2", type: "truss", nodes: ["B1", "B2"], material: "1", section: "1" },
        { id: "TC1", type: "truss", nodes: ["B0", "T0"], material: "1", section: "1" },
        { id: "TC2", type: "truss", nodes: ["T0", "T1"], material: "1", section: "1" },
        { id: "TC3", type: "truss", nodes: ["T1", "T2"], material: "1", section: "1" },
        { id: "TC4", type: "truss", nodes: ["T2", "B2"], material: "1", section: "1" },
        { id: "W1", type: "truss", nodes: ["T0", "B1"], material: "1", section: "1" },
        { id: "W2", type: "truss", nodes: ["B1", "T2"], material: "1", section: "1" },
        { id: "W3", type: "truss", nodes: ["B1", "T1"], material: "1", section: "1" },
        { id: "W4", type: "truss", nodes: ["T0", "T2"], material: "1", section: "1" },
      ],
      materials: [steel()],
      sections: [rodSection()],
      load_cases: [{ id: "LC1", type: "dead", loads: [
        { node: "T0", fz: -20 },
        { node: "T1", fz: -20 },
        { node: "T2", fz: -20 },
      ] }],
      load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
      metadata: { source: "ground-truth", inferredType: "truss", frameDimension: "2d" },
    },
  };
}

function buildTriangularRoofTruss(id, description, opts) {
  const { span, height, panels, nodeLoad } = opts;
  const dx = span / panels;
  const nodes = [];
  const elements = [];
  for (let i = 0; i <= panels; i++) {
    nodes.push({ id: `B${i}`, x: i * dx, y: 0, z: 0, ...(i === 0 ? { restraints: fixed } : i === panels ? { restraints: roller } : {}) });
  }
  const topNodes = [];
  for (let i = 1; i < panels; i++) {
    const x = i * dx;
    const z = height * (1 - Math.abs(x - span / 2) / (span / 2));
    topNodes.push({ id: `T${i}`, x, z });
  }
  if (!topNodes.some((node) => Math.abs(node.x - span / 2) < 1e-6)) {
    topNodes.push({ id: "TA", x: span / 2, z: height });
  }
  topNodes.sort((a, b) => a.x - b.x);
  for (const node of topNodes) nodes.push({ id: node.id, x: node.x, y: 0, z: node.z });
  for (let i = 0; i < panels; i++) {
    elements.push({ id: `BC${i}`, type: "truss", nodes: [`B${i}`, `B${i + 1}`], material: "1", section: "1" });
  }
  const topPath = ["B0", ...topNodes.map((node) => node.id), `B${panels}`];
  for (let i = 0; i < topPath.length - 1; i++) {
    elements.push({ id: `TC${i}`, type: "truss", nodes: [topPath[i], topPath[i + 1]], material: "1", section: "1" });
  }
  for (const node of topNodes) {
    const nearestBottom = Math.round(node.x / dx);
    const bottomId = `B${nearestBottom}`;
    elements.push({ id: `WV${node.id}`, type: "truss", nodes: [bottomId, node.id], material: "1", section: "1" });
  }
  for (let i = 1; i < topNodes.length; i++) {
    const prevBottom = `B${Math.round(topNodes[i - 1].x / dx)}`;
    elements.push({ id: `WD${i}`, type: "truss", nodes: [prevBottom, topNodes[i].id], material: "1", section: "1" });
  }
  return {
    id,
    inferredType: "truss",
    description,
    model: {
      schema_version: "2.0.0",
      unit_system: "SI",
      nodes,
      elements,
      materials: [steel()],
      sections: [rodSection()],
      load_cases: [{ id: "LC1", type: "dead", loads: topNodes.map((node) => ({ node: node.id, fz: -nodeLoad })) }],
      load_combinations: [{ id: "ULS", factors: { LC1: 1.0 } }],
      metadata: { source: "ground-truth", inferredType: "truss", frameDimension: "2d" },
    },
  };
}

models.push(buildBeamModel("beam-simple-8m-udl15", "简支梁8m，均布荷载15kN/m", {
  supportPositions: [0, 8],
  endPosition: 8,
  restraintsByX: { 0: pinned, 8: roller },
  udl: 15,
}));
models.push(buildBeamModel("beam-simple-8m-udl18", "简支梁8m，均布荷载18kN/m", {
  supportPositions: [0, 8],
  endPosition: 8,
  restraintsByX: { 0: pinned, 8: roller },
  udl: 18,
}));
models.push(buildBeamModel("beam-simple-7p5m-udl18", "简支梁7.5m，均布荷载18kN/m", {
  supportPositions: [0, 7.5],
  endPosition: 7.5,
  restraintsByX: { 0: pinned, 7.5: roller },
  udl: 18,
}));
models.push(buildBeamModel("beam-simple-4m-point25", "简支梁4m，跨中集中力25kN", {
  supportPositions: [0, 4],
  endPosition: 4,
  restraintsByX: { 0: pinned, 4: roller },
  pointLoads: [{ x: 2, fz: 25 }],
}));
models.push(buildBeamModel("beam-cantilever-3m-point10", "悬臂梁3m，自由端集中力10kN", {
  supportPositions: [0],
  endPosition: 3,
  restraintsByX: { 0: fixed },
  pointLoads: [{ x: 3, fz: 10 }],
}));
models.push(buildBeamModel("beam-overhang-5m-1p5m-udl15", "外伸梁，简支跨5m，外伸1.5m，均布荷载15kN/m", {
  supportPositions: [0, 5],
  endPosition: 6.5,
  restraintsByX: { 0: pinned, 5: roller },
  udl: 15,
}));
models.push(buildBeamModel("dspan-unequal-4-7-udl10-point30", "不等跨连续梁4m+7m，均布荷载10kN/m，长跨跨中集中力30kN", {
  inferredType: "double-span-beam",
  supportPositions: [0, 4, 11],
  endPosition: 11,
  restraintsByX: { 0: pinned, 4: roller, 11: roller },
  udl: 10,
  pointLoads: [{ x: 7.5, fz: 30 }],
}));

models.push(build2dFrame("frame-simple-1s1b-10k", "单层单跨钢框架，H=4.5m，L=6m，梁线荷载10kN/m", {
  bayWidths: [6],
  storyHeights: [4.5],
  floorLoads: [10],
}));
models.push(build2dFrame("frame-2s1b-6m-10k", "2层单跨钢框架，层高3.6m，跨度6m，楼面荷载10kN/m2", {
  bayWidths: [6],
  storyHeights: [3.6, 3.6],
  floorLoads: [10, 10],
  floorLoadUnit: "area",
}));
models.push(build2dFrame("frame-2s1b-6m-10k-wind", "2层单跨钢框架，层高3.6m，跨度6m，楼面荷载10kN/m2，风荷载0.5kN/m2", {
  bayWidths: [6],
  storyHeights: [3.6, 3.6],
  floorLoads: [10, 10],
  floorLoadUnit: "area",
  lateralLoads: [
    { storyIndex: 1, xIndices: [1], fx: 10 },
    { storyIndex: 2, xIndices: [1], fx: 15 },
  ],
}));
models.push(build2dFrame("frame-2s2b-5p4-6-10k", "2层2跨钢框架，层高3.6m，跨度5.4m+6m，楼面线荷载10kN/m", {
  bayWidths: [5.4, 6],
  storyHeights: [3.6, 3.6],
  floorLoads: [10, 10],
}));
models.push(build2dFrame("frame-3s2b-5p4-6-15k", "3层2跨钢框架，层高3.3m，跨度5.4m+6m，楼面线荷载15kN/m", {
  bayWidths: [5.4, 6],
  storyHeights: [3.3, 3.3, 3.3],
  floorLoads: [15, 15, 15],
}));
models.push(build2dFrame("frame-3s2b-6m-10k-wind", "3层2跨钢框架，层高3.6m，6m等跨，楼面线荷载10kN/m，右侧节点等效水平风荷载10/15/20kN", {
  bayWidths: [6, 6],
  storyHeights: [3.6, 3.6, 3.6],
  floorLoads: [10, 10, 10],
  lateralLoads: [
    { storyIndex: 1, xIndices: [2], fx: 10 },
    { storyIndex: 2, xIndices: [2], fx: 15 },
    { storyIndex: 3, xIndices: [2], fx: 20 },
  ],
}));
models.push(build2dFrame("frame-industrial-24m-12m-crane10t", "单层工业重型厂房钢框架，跨度24m，高度12m，10t吊车，屋面荷载1.5kN/m2", {
  bayWidths: [24],
  storyHeights: [12],
  floorLoads: [1.5],
  floorLoadUnit: "area",
  lateralLoads: [{ storyIndex: 1, xIndices: [1], fx: 10 }],
  pointLoads: [{ storyIndex: 1, xIndex: 1, fz: -98 }],
}));

models.push(build2dFrame("concrete-frame-2s1b-6m-12k", "2层混凝土框架，层高3.6m，跨度6m，楼面荷载12kN/m2", {
  inferredType: "frame",
  bayWidths: [6],
  storyHeights: [3.6, 3.6],
  floorLoads: [12, 12],
  floorLoadUnit: "area",
  material: concrete("1", "C30"),
  sections: [rectSection("1", "C30 500x500", 0.5, 0.5, "column"), rectSection("2", "C30 300x600", 0.3, 0.6, "beam")],
}));
models.push(build2dFrame("concrete-frame-2s1b-6m-10k", "2层混凝土框架，层高3.6m，跨度6m，楼面荷载10kN/m2", {
  inferredType: "frame",
  bayWidths: [6],
  storyHeights: [3.6, 3.6],
  floorLoads: [10, 10],
  floorLoadUnit: "area",
  material: concrete("1", "C30"),
  sections: [rectSection("1", "C30 500x500", 0.5, 0.5, "column"), rectSection("2", "C30 300x600", 0.3, 0.6, "beam")],
}));
models.push(build2dFrame("concrete-frame-3s1b-6m-10k", "3层混凝土框架，层高3.3m，跨度6m，楼面荷载10kN/m2", {
  inferredType: "frame",
  bayWidths: [6],
  storyHeights: [3.3, 3.3, 3.3],
  floorLoads: [10, 10, 10],
  floorLoadUnit: "area",
  material: concrete("1", "C35"),
  sections: [rectSection("1", "C35 500x500", 0.5, 0.5, "column"), rectSection("2", "C35 300x600", 0.3, 0.6, "beam")],
}));
models.push(build2dFrame("concrete-frame-2s3b-6m-8k", "2层3跨混凝土框架，6m等跨，楼面荷载8kN/m", {
  inferredType: "frame",
  bayWidths: [6, 6, 6],
  storyHeights: [3.6, 3.6],
  floorLoads: [8, 8],
  material: concrete("1", "C30"),
  sections: [rectSection("1", "C30 500x500", 0.5, 0.5, "column"), rectSection("2", "C30 300x600", 0.3, 0.6, "beam")],
}));
models.push(build3dFrame("frame3d-concrete-2s-2x1y-12k", "2层3D混凝土框架，X向2跨6m+6m，Y向1跨5m，层高3.6m，楼面荷载12kN/m2", {
  bayWidthsX: [6, 6],
  bayWidthsY: [5],
  storyHeights: [3.6, 3.6],
  floorLoads: [
    { storyIndex: 1, loadPerArea: 12 },
    { storyIndex: 2, loadPerArea: 12 },
  ],
  material: concrete("1", "C30"),
  sections: [rectSection("1", "C30 500x500", 0.5, 0.5, "column"), rectSection("2", "C30 300x600", 0.3, 0.6, "beam")],
}));
models.push(build3dFrame("frame3d-steel-2s-2x1y-8k", "2层3D钢框架，X向2跨6m+6m，Y向1跨5m，层高3.6m，楼面荷载8kN/m2", {
  bayWidthsX: [6, 6],
  bayWidthsY: [5],
  storyHeights: [3.6, 3.6],
  floorLoads: [
    { storyIndex: 1, loadPerArea: 8 },
    { storyIndex: 2, loadPerArea: 8 },
  ],
  material: q345(),
  sections: [hSection("1", "HW350x350", "column"), hSection("2", "HN500x200", "beam")],
}));
models.push(build3dFrame("frame3d-steel-3s-1x2y-10k", "3层3D钢框架，X向1跨6m，Y向2跨5m+5m，层高3.3m，楼面荷载10kN/m2", {
  bayWidthsX: [6],
  bayWidthsY: [5, 5],
  storyHeights: [3.3, 3.3, 3.3],
  floorLoads: [
    { storyIndex: 1, loadPerArea: 10 },
    { storyIndex: 2, loadPerArea: 10 },
    { storyIndex: 3, loadPerArea: 10 },
  ],
  material: q345(),
  sections: [hSection("1", "HW350x350", "column"), hSection("2", "HN500x200", "beam")],
}));

models.push(buildColumn("column-concrete-4p5-500", "独立混凝土柱，400x400mm，高4.5m，柱顶轴向荷载500kN", {
  height: 4.5,
  axial: 500,
  material: concrete("1", "C30"),
  section: rectSection("1", "C30 400x400", 0.4, 0.4, "column"),
}));
models.push(buildColumn("column-concrete-4p2-600-30", "独立混凝土柱，450x450mm，高4.2m，轴压600kN，水平荷载30kN", {
  height: 4.2,
  axial: 600,
  lateral: 30,
  material: concrete("1", "C30"),
  section: rectSection("1", "C30 450x450", 0.45, 0.45, "column"),
}));
models.push(buildColumn("column-steel-5m-700", "独立钢柱，H300x300，高5m，轴压700kN", {
  height: 5,
  axial: 700,
  material: q345(),
  section: hSection("1", "H300x300", "column"),
}));

models.push(buildPortalSingle("portal-simple-21m-7p5-8k", "单跨门式刚架，跨度21m，高7.5m，屋面荷载8kN/m", {
  span: 21,
  height: 7.5,
  roofLoad: 8,
}));
models.push(buildPortalDouble("portal-double-36m-9m-crane5t", "双跨门式刚架，2x18m，高9m，5t吊车，屋面荷载6kN/m", {
  span: 18,
  height: 9,
  roofLoad: 6,
  craneTons: 5,
}));
models.push(buildMezzaninePortal());

models.push(build2dFrame("generic-single-bay-6m-4m-lateral50", "单层单跨平面结构，宽6m，高4m，顶部水平荷载50kN", {
  inferredType: "generic",
  bayWidths: [6],
  storyHeights: [4],
  lateralLoads: [{ storyIndex: 1, xIndices: [1], fx: 50 }],
}));

models.push(buildTrapezoidTruss("truss-complex-trap-12k", "梯形屋架，跨度18m，高2.5m，6节间，上弦节点荷载12kN", {
  span: 18,
  height: 2.5,
  panels: 6,
  nodeLoad: 12,
  loadChord: "top",
}));
models.push(buildPanelTruss("truss-roof-18m-3m-12k", "钢屋架，跨度18m，高3m，6节间，节点荷载12kN", {
  span: 18,
  height: 3,
  panels: 6,
  nodeLoad: 12,
  loadChord: "top",
}));
models.push(buildTriangularTruss12());
models.push(buildTriangularRoofTruss("truss-triangle-15m-2p5-10k", "三角屋架，跨度15m，高2.5m，5节间，上弦节点荷载10kN", {
  span: 15,
  height: 2.5,
  panels: 5,
  nodeLoad: 10,
}));
models.push(buildPanelTruss("truss-warren-12m-2m-8k", "Warren桁架，跨度12m，高2m，6节间，下弦节点荷载8kN", {
  span: 12,
  height: 2,
  panels: 6,
  nodeLoad: 8,
  loadChord: "bottom",
}));

// --- write output ---
writeFileSync(OUT, JSON.stringify(models, null, 2));
console.log(`Generated ${models.length} ground-truth models → ${OUT}`);
for (const m of models) {
  const n = m.model.nodes.length;
  const e = m.model.elements.length;
  console.log(`  ${m.id}: ${m.inferredType}, ${n} nodes, ${e} elements`);
}
