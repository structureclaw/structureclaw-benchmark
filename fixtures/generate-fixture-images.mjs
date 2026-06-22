#!/usr/bin/env node

// Generates structural diagram PNG fixtures for multimodal benchmark scenarios.
// Usage: node tests/llm-benchmark/fixtures/generate-fixture-images.mjs

import sharp from "sharp";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = __dirname;

const W = 640;
const H = 400;

function svg(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#fff"/>
    <style>
      text { font-family: 'Courier New', monospace; fill: #222; }
      .dim { font-size: 16px; fill: #1a65ac; font-weight: bold; }
      .label { font-size: 13px; fill: #555; }
      .title { font-size: 14px; fill: #333; font-weight: bold; }
      .member { stroke: #333; stroke-width: 2.5; fill: none; stroke-linecap: round; }
      .support { fill: #666; stroke: #333; stroke-width: 1.5; }
      .load-arrow { stroke: #c0392b; stroke-width: 1.8; fill: none; marker-end: url(#arrowR); }
      .reaction { stroke: #27ae60; stroke-width: 1.8; fill: none; }
    </style>
    <defs>
      <marker id="arrowR" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
        <path d="M0,0 L8,3 L0,6 Z" fill="#c0392b"/>
      </marker>
      <marker id="arrowD" markerWidth="6" markerHeight="8" refX="3" refY="8" orient="auto">
        <path d="M0,0 L6,0 L3,8 Z" fill="#c0392b"/>
      </marker>
    </defs>
    ${body}
  </svg>`;
}

function triangleSupport(cx, cy, size = 14) {
  const pts = `${cx},${cy} ${cx - size},${cy + size * 1.2} ${cx + size},${cy + size * 1.2}`;
  const baseY = cy + size * 1.2;
  return `<polygon points="${pts}" class="support"/>
    <line x1="${cx - size - 4}" y1="${baseY + 4}" x2="${cx + size + 4}" y2="${baseY + 4}" stroke="#666" stroke-width="2"/>
    <line x1="${cx - size - 2}" y1="${baseY + 8}" x2="${cx + size + 2}" y2="${baseY + 8}" stroke="#999" stroke-width="1"/>`;
}

// 1. beam-sketch.png — simply supported beam with UDL
const beamSketch = svg(`
  <text x="${W / 2}" y="30" text-anchor="middle" class="title">Simply Supported Beam</text>
  <!-- beam line -->
  <line x1="120" y1="180" x2="520" y2="180" class="member"/>
  <!-- supports -->
  ${triangleSupport(120, 180)}
  ${triangleSupport(520, 180)}
  <!-- UDL arrows -->
  ${Array.from({ length: 9 }, (_, i) => {
    const x = 160 + i * 40;
    return `<line x1="${x}" y1="100" x2="${x}" y2="175" class="load-arrow"/>`;
  }).join("\n  ")}
  <line x1="160" y1="100" x2="480" y2="100" stroke="#c0392b" stroke-width="1.5"/>
  <text x="320" y="90" text-anchor="middle" class="dim">20 kN/m</text>
  <!-- dimension line -->
  <line x1="120" y1="260" x2="520" y2="260" stroke="#1a65ac" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="320" y="285" text-anchor="middle" class="dim">L = 6 m</text>
  <!-- labels -->
  <text x="120" y="230" text-anchor="middle" class="label">A (pin)</text>
  <text x="520" y="230" text-anchor="middle" class="label">B (roller)</text>
`);

// 2. frame-sketch.png — 2-story 1-bay frame
const frameSketch = svg(`
  <text x="${W / 2}" y="28" text-anchor="middle" class="title">2-Story Steel Frame</text>
  <!-- columns and beams -->
  <rect x="160" y="100" width="4" height="220" fill="#333" rx="1"/>
  <rect x="436" y="100" width="4" height="220" fill="#333" rx="1"/>
  <line x1="160" y1="210" x2="440" y2="210" class="member"/>
  <line x1="160" y1="100" x2="440" y2="100" class="member"/>
  <!-- fixed supports -->
  <line x1="145" y1="322" x2="175" y2="322" stroke="#333" stroke-width="3"/>
  <line x1="425" y1="322" x2="455" y2="322" stroke="#333" stroke-width="3"/>
  <line x1="160" y1="320" x2="160" y2="322" stroke="#333" stroke-width="2.5"/>
  <line x1="440" y1="320" x2="440" y2="322" stroke="#333" stroke-width="2.5"/>
  <!-- equivalent beam line load arrows -->
  ${[200, 280, 360].map(x => `<line x1="${x}" y1="72" x2="${x}" y2="95" class="load-arrow"/>`).join("\n  ")}
  <text x="300" y="65" text-anchor="middle" class="dim">60 kN/m</text>
  ${[200, 280, 360].map(x => `<line x1="${x}" y1="182" x2="${x}" y2="205" class="load-arrow"/>`).join("\n  ")}
  <text x="300" y="178" text-anchor="middle" class="dim">60 kN/m</text>
  <!-- dimensions -->
  <text x="140" y="160" text-anchor="end" class="dim">3.6m</text>
  <text x="140" y="270" text-anchor="end" class="dim">3.6m</text>
  <line x1="152" y1="100" x2="152" y2="210" stroke="#1a65ac" stroke-width="1" stroke-dasharray="3,3"/>
  <line x1="152" y1="210" x2="152" y2="320" stroke="#1a65ac" stroke-width="1" stroke-dasharray="3,3"/>
  <text x="300" y="340" text-anchor="middle" class="dim">6m</text>
  <line x1="160" y1="332" x2="440" y2="332" stroke="#1a65ac" stroke-width="1" stroke-dasharray="3,3"/>
`);

// 3. truss-diagram.png — triangular truss
const trussDiagram = svg(`
  <text x="${W / 2}" y="28" text-anchor="middle" class="title">Triangular Truss</text>
  <!-- bottom chord -->
  <line x1="100" y1="260" x2="540" y2="260" class="member"/>
  <!-- top chord -->
  <line x1="100" y1="260" x2="320" y2="100" class="member"/>
  <line x1="320" y1="100" x2="540" y2="260" class="member"/>
  <!-- web members -->
  <line x1="210" y1="180" x2="320" y2="260" class="member"/>
  <line x1="210" y1="180" x2="430" y2="180" class="member"/>
  <line x1="320" y1="100" x2="320" y2="260" class="member" stroke-dasharray="6,3"/>
  <line x1="430" y1="180" x2="320" y2="260" class="member"/>
  <!-- supports -->
  ${triangleSupport(100, 260)}
  <circle cx="540" cy="260" r="5" fill="#666" stroke="#333" stroke-width="1.5"/>
  <line x1="525" y1="268" x2="555" y2="268" stroke="#666" stroke-width="2"/>
  <line x1="530" y1="274" x2="550" y2="274" stroke="#999" stroke-width="1"/>
  <!-- node loads -->
  ${[210, 320, 430].map(x => `<line x1="${x}" y1="70" x2="${x}" y2="${x === 320 ? 95 : 175}" class="load-arrow"/><text x="${x}" y="62" text-anchor="middle" class="dim">20kN</text>`).join("\n  ")}
  <!-- dimensions -->
  <text x="320" y="310" text-anchor="middle" class="dim">12m</text>
  <text x="80" y="180" text-anchor="end" class="dim">3m</text>
  <line x1="88" y1="100" x2="88" y2="260" stroke="#1a65ac" stroke-width="1" stroke-dasharray="3,3"/>
`);

// 4. portal-frame-diagram.png — portal frame
const portalFrame = svg(`
  <text x="${W / 2}" y="28" text-anchor="middle" class="title">Portal Frame</text>
  <!-- left column -->
  <line x1="120" y1="310" x2="120" y2="120" class="member"/>
  <!-- right column -->
  <line x1="520" y1="310" x2="520" y2="120" class="member"/>
  <!-- roof beam -->
  <line x1="120" y1="120" x2="520" y2="120" class="member"/>
  <!-- fixed supports -->
  <line x1="105" y1="312" x2="135" y2="312" stroke="#333" stroke-width="3"/>
  <line x1="505" y1="312" x2="535" y2="312" stroke="#333" stroke-width="3"/>
  <!-- UDL on roof -->
  ${Array.from({ length: 9 }, (_, i) => {
    const x = 150 + i * 42;
    const yTop = 112;
    return `<line x1="${x}" y1="${yTop - 25}" x2="${x}" y2="${yTop - 3}" class="load-arrow"/>`;
  }).join("\n  ")}
  <text x="320" y="70" text-anchor="middle" class="dim">6 kN/m</text>
  <!-- dimensions -->
  <text x="320" y="340" text-anchor="middle" class="dim">18m</text>
  <text x="95" y="215" text-anchor="end" class="dim">7m</text>
  <line x1="108" y1="120" x2="108" y2="310" stroke="#1a65ac" stroke-width="1" stroke-dasharray="3,3"/>
`);

// 5. incomplete-dimensions.png — frame without dimensions
const incompleteDimensions = svg(`
  <text x="${W / 2}" y="28" text-anchor="middle" class="title">Structure Diagram</text>
  <!-- vague frame shape, no numbers -->
  <line x1="160" y1="300" x2="160" y2="120" class="member"/>
  <line x1="480" y1="300" x2="480" y2="120" class="member"/>
  <line x1="160" y1="120" x2="480" y2="120" class="member"/>
  <line x1="160" y1="210" x2="480" y2="210" class="member"/>
  <!-- supports -->
  ${triangleSupport(160, 300)}
  ${triangleSupport(480, 300)}
  <!-- question marks -->
  <text x="120" y="210" text-anchor="middle" font-size="24" fill="#c0392b">?</text>
  <text x="320" y="330" text-anchor="middle" font-size="24" fill="#c0392b">?</text>
  <text x="320" y="105" text-anchor="middle" font-size="24" fill="#c0392b">?</text>
`);

// 6. cropped-frame-sketch.png — partial frame drawing with missing labels
const croppedFrameSketch = svg(`
  <text x="${W / 2}" y="28" text-anchor="middle" class="title">Partial Frame Drawing</text>
  <rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>
  <g transform="translate(-70, 20)">
    <line x1="160" y1="110" x2="160" y2="315" class="member"/>
    <line x1="440" y1="110" x2="440" y2="315" class="member"/>
    <line x1="160" y1="110" x2="440" y2="110" class="member"/>
    <line x1="160" y1="210" x2="440" y2="210" class="member"/>
    <line x1="145" y1="318" x2="175" y2="318" stroke="#333" stroke-width="3"/>
    <line x1="425" y1="318" x2="455" y2="318" stroke="#333" stroke-width="3"/>
    ${[205, 285, 365].map(x => `<line x1="${x}" y1="82" x2="${x}" y2="105" class="load-arrow"/>`).join("\n    ")}
  </g>
  <rect x="420" y="0" width="220" height="${H}" fill="#fff"/>
  <rect x="0" y="300" width="${W}" height="100" fill="#fff"/>
  <text x="78" y="190" text-anchor="middle" font-size="22" fill="#c0392b">?</text>
  <text x="300" y="82" text-anchor="middle" class="dim">load?</text>
  <text x="300" y="350" text-anchor="middle" class="dim">span label cropped</text>
`);

const fixtures = [
  { name: "beam-sketch.png", svg: beamSketch },
  { name: "frame-sketch.png", svg: frameSketch },
  { name: "truss-diagram.png", svg: trussDiagram },
  { name: "portal-frame-diagram.png", svg: portalFrame },
  { name: "incomplete-dimensions.png", svg: incompleteDimensions },
  { name: "cropped-frame-sketch.png", svg: croppedFrameSketch },
];

async function generateAll() {
  for (const { name, svg: svgContent } of fixtures) {
    const outPath = join(outDir, name);
    await sharp(Buffer.from(svgContent)).png().toFile(outPath);
    const info = await sharp(outPath).metadata();
    console.log(`  ${name}: ${info.width}x${info.height}, ${info.size} bytes`);
  }

  // 7. blurry-image.png — blur the beam sketch
  const beamPath = join(outDir, "beam-sketch.png");
  const blurryPath = join(outDir, "blurry-image.png");
  await sharp(beamPath).blur(8).toFile(blurryPath);
  const blurryInfo = await sharp(blurryPath).metadata();
  console.log(`  blurry-image.png: ${blurryInfo.width}x${blurryInfo.height}, ${blurryInfo.size} bytes`);

  console.log("\nAll fixtures generated.");
}

generateAll().catch((err) => {
  console.error("Error generating fixtures:", err);
  process.exit(1);
});
