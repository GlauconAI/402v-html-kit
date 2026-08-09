export const ARTIFACT_RESOURCE_LIMITS = Object.freeze({
  artifactBytes: 64 * 1024 * 1024,
  dataBlocks: 32,
  styles: 16,
  scripts: 16,
  svgAssets: 16,
  rawJsonBytes: 32 * 1024 * 1024,
  canonicalJsonNodes: 250_000,
  stylesheetBytes: 8 * 1024 * 1024,
  scriptBytes: 8 * 1024 * 1024,
  svgBytes: 20 * 1024 * 1024,
  slotBytes: 4 * 1024 * 1024,
  slotAggregateBytes: 8 * 1024 * 1024,
});
