export default Object.freeze({
  themeContractVersion: 1,
  id: "paper",
  version: "1.0.0",
  displayName: "Paper",
  render(input) {
    const body = input.mode === "note"
      ? `<main class="paper">${input.content.articleHtml ?? ""}</main>`
      : `<main class="paper">${input.content.slots?.mainSections ?? ""}</main>`;
    return Object.freeze({
      lang: input.metadata.lang || "en",
      styles: "body{margin:0;background:#f7f2e8;color:#201b16;font:16px/1.6 Georgia,serif}.paper{max-width:70ch;margin:auto;padding:3rem 1.25rem}",
      bodyHtml: body,
    });
  },
});
