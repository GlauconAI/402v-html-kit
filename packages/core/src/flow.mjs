import { ArtifactBuildError } from "./errors.mjs";
import { ARTIFACT_RESOURCE_LIMITS } from "./resource-limits.mjs";

const NODE_WIDTH = 180;
const NODE_HEIGHT = 72;
const COLUMN_GAP = 90;
const ROW_GAP = 48;
const MARGIN = 44;

function fail(message, details = undefined) {
  throw new ArtifactBuildError("INVALID_FLOW_DIAGRAM", message, details);
}

function failResource(message) {
  throw new ArtifactBuildError("RESOURCE_LIMIT_EXCEEDED", message);
}

export function renderFlowDiagram(
  source,
  {
    markerId = "flow-arrow",
    titleId = "flow-diagram-title",
    resourceLimits = ARTIFACT_RESOURCE_LIMITS,
  } = {},
) {
  const { direction, nodes, edges } = parseFlowDiagram(source, {
    resourceLimits,
  });
  const positions = layoutNodes(nodes, edges, direction);
  let maximumX = 0;
  let maximumY = 0;
  const positionById = new Map();
  for (const position of positions) {
    maximumX = Math.max(maximumX, position.x + NODE_WIDTH);
    maximumY = Math.max(maximumY, position.y + NODE_HEIGHT);
    positionById.set(position.id, position);
  }
  const width = maximumX + MARGIN;
  const height = maximumY + MARGIN;
  const markup = [];
  let projectedBytes = 0;
  const reserve = (bytes) => {
    if (projectedBytes + bytes > resourceLimits.svgBytes) {
      failResource("Flow SVG exceeds its projected byte limit");
    }
    projectedBytes += bytes;
  };
  const append = (fragment) => {
    reserve(Buffer.byteLength(fragment, "utf8"));
    markup.push(fragment);
  };
  const appendXml = (value) => {
    const string = String(value);
    let escapedBytes = 0;
    for (const codePoint of string) {
      escapedBytes += Buffer.byteLength(xmlToken(codePoint), "utf8");
    }
    reserve(escapedBytes);
    markup.push(escapeXml(string));
  };

  append(`<figure class="flow-diagram" data-diagram="flowchart">
  <svg role="img" aria-labelledby="`);
  appendXml(titleId);
  append(`" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <title id="`);
  appendXml(titleId);
  append(`">Flow diagram</title>
    <defs>
      <marker id="`);
  appendXml(markerId);
  append(`" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L8,4 L0,8 z"/>
      </marker>
    </defs>
    `);
  for (const edge of edges) {
    const from = positionById.get(edge.from);
    const to = positionById.get(edge.to);
    const start = nodeAnchor(from, to, direction);
    const end = nodeAnchor(to, from, direction);
    const labelX = (start.x + end.x) / 2;
    const labelY = (start.y + end.y) / 2 - 8;
    append(`<g class="flow-edge"><path d="M ${start.x} ${start.y} L ${end.x} ${end.y}" marker-end="url(#`);
    appendXml(markerId);
    append(`)"/>`);
    if (edge.label) {
      append(`<text class="flow-edge-label" x="${labelX}" y="${labelY}" text-anchor="middle">`);
      appendXml(edge.label);
      append("</text>");
    }
    append("</g>");
  }
  append("\n    ");
  for (const position of positions) {
    const node = nodes.get(position.id);
    const shape = renderNodeShape(position, node.shape);
    const labelLines = wrapLabel(node.label, 22);
    const firstY =
      position.y + NODE_HEIGHT / 2 - ((labelLines.length - 1) * 17) / 2;
    append(`<g class="flow-node flow-node-${node.shape}" data-node-id="`);
    appendXml(position.id);
    append(`">${shape}<text text-anchor="middle">`);
    for (let index = 0; index < labelLines.length; index += 1) {
      append(`<tspan x="${position.x + NODE_WIDTH / 2}" y="${firstY + index * 17}">`);
      appendXml(labelLines[index]);
      append("</tspan>");
    }
    append("</text></g>");
  }
  append(`
  </svg>
</figure>`);
  return markup.join("");
}

export function parseFlowDiagram(
  source,
  { resourceLimits = ARTIFACT_RESOURCE_LIMITS } = {},
) {
  if (typeof source !== "string" || !source.trim()) {
    fail("Flow diagram is empty");
  }
  if (Buffer.byteLength(source, "utf8") > resourceLimits.slotBytes) {
    failResource("Flow source exceeds its byte limit");
  }

  let direction = "LR";
  const nodes = new Map();
  const edges = [];
  let structures = 0;
  let firstStatement = true;
  const reserveStructure = () => {
    structures += 1;
    if (structures > resourceLimits.canonicalJsonNodes) {
      failResource("Flow structure exceeds its syntax record limit");
    }
  };

  for (const entry of flowSourceLines(source)) {
    if (!entry.text || entry.text.startsWith("%%")) continue;
    reserveStructure();
    if (firstStatement && /^flowchart\s+/i.test(entry.text)) {
      const match = entry.text.match(/^flowchart\s+(LR|TD)$/i);
      if (!match) {
        fail("Flow direction must be LR or TD", { line: entry.line });
      }
      direction = match[1].toUpperCase();
      firstStatement = false;
      continue;
    }
    firstStatement = false;
    const match = entry.text.match(
      /^(.+?)\s*-->\s*(?:\|([^|]+)\|\s*)?(.+)$/,
    );
    if (!match) {
      fail("Flow diagram contains an unsupported statement", {
        line: entry.line,
      });
    }

    const from = parseEndpoint(match[1].trim(), entry.line);
    const to = parseEndpoint(match[3].trim(), entry.line);
    upsertNode(nodes, from, reserveStructure);
    upsertNode(nodes, to, reserveStructure);
    reserveStructure();
    edges.push({
      from: from.id,
      to: to.id,
      label: match[2]?.trim() || "",
    });
  }

  if (nodes.size < 2 || edges.length === 0) {
    fail("Flow diagram needs at least two nodes and one arrow");
  }

  return { direction, nodes, edges };
}

function* flowSourceLines(source) {
  let start = 0;
  let line = 1;
  for (let index = 0; index <= source.length; index += 1) {
    const atEnd = index === source.length;
    if (!atEnd && source[index] !== "\n" && source[index] !== "\r") continue;
    yield { line, text: source.slice(start, index).trim() };
    if (!atEnd && source[index] === "\r" && source[index + 1] === "\n") {
      index += 1;
    }
    start = index + 1;
    line += 1;
  }
}

function parseEndpoint(value, line) {
  const match = value.match(
    /^([A-Za-z][A-Za-z0-9_-]*)(?:\[(.+)\]|\{(.+)\}|\((.+)\))?$/,
  );
  if (!match) {
    fail("Flow diagram contains an invalid node", { line });
  }

  const label = match[2] || match[3] || match[4] || match[1];
  const shape = match[3] ? "decision" : match[4] ? "pill" : "box";
  return { id: match[1], label, shape };
}

function upsertNode(nodes, candidate, reserveStructure) {
  const existing = nodes.get(candidate.id);
  if (!existing) reserveStructure();
  if (!existing || candidate.label !== candidate.id) {
    nodes.set(candidate.id, candidate);
  }
}

function layoutNodes(nodes, edges, direction) {
  const rankById = new Map();
  const firstId = nodes.keys().next().value;
  rankById.set(firstId, 0);

  for (const edge of edges) {
    if (!rankById.has(edge.from)) {
      rankById.set(edge.from, 0);
    }
    if (!rankById.has(edge.to)) {
      rankById.set(edge.to, rankById.get(edge.from) + 1);
    }
  }

  for (const id of nodes.keys()) {
    if (!rankById.has(id)) rankById.set(id, 0);
  }

  const groups = new Map();
  for (const [id, rank] of rankById) {
    const ids = groups.get(rank) || [];
    ids.push(id);
    groups.set(rank, ids);
  }

  const positions = [];
  for (const [rank, ids] of [...groups.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    ids.forEach((id, index) => {
      positions.push({
        id,
        x:
          direction === "LR"
            ? MARGIN + rank * (NODE_WIDTH + COLUMN_GAP)
            : MARGIN + index * (NODE_WIDTH + COLUMN_GAP),
        y:
          direction === "LR"
            ? MARGIN + index * (NODE_HEIGHT + ROW_GAP)
            : MARGIN + rank * (NODE_HEIGHT + ROW_GAP),
      });
    });
  }

  return positions;
}

function nodeAnchor(node, other, direction) {
  if (direction === "LR") {
    return {
      x: other.x < node.x ? node.x : node.x + NODE_WIDTH,
      y: node.y + NODE_HEIGHT / 2,
    };
  }

  return {
    x: node.x + NODE_WIDTH / 2,
    y: other.y < node.y ? node.y : node.y + NODE_HEIGHT,
  };
}

function renderNodeShape(position, shape) {
  if (shape === "decision") {
    const centerX = position.x + NODE_WIDTH / 2;
    const centerY = position.y + NODE_HEIGHT / 2;
    return `<path d="M ${centerX} ${position.y} L ${position.x + NODE_WIDTH} ${centerY} L ${centerX} ${position.y + NODE_HEIGHT} L ${position.x} ${centerY} Z"/>`;
  }

  const radius = shape === "pill" ? NODE_HEIGHT / 2 : 12;
  return `<rect x="${position.x}" y="${position.y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="${radius}"/>`;
}

function wrapLabel(label, length) {
  const words = label.trim().split(/\s+/);
  if (words.length === 1 && words[0].length <= length) return words;

  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > length && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3);
}

function xmlToken(codePoint) {
  if (codePoint === "&") return "&amp;";
  if (codePoint === "<") return "&lt;";
  if (codePoint === ">") return "&gt;";
  if (codePoint === '"') return "&quot;";
  if (codePoint === "'") return "&#39;";
  return codePoint;
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
