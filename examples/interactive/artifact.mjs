export default {
  contractVersion: 2,
  mode: "interactive",
  rootDirectory: ".",
  metadata: {
    title: "Offline Interactive Example",
    description: "A deterministic data-backed artifact that runs entirely offline.",
    eyebrow: "HTML Kit Example",
    lang: "en",
  },
  dataBlocks: [{ id: "dashboard", source: "./data.json" }],
  renderer: "./renderer.mjs",
  styles: [],
  scripts: [],
  svgAssets: [],
  requiredDataBlocks: ["dashboard"],
  theme: "@402v/theme-402v",
};
