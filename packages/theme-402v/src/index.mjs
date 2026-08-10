import { renderInteractiveShell } from "./interactive-shell.mjs";
import { renderNoteShell } from "./note-shell.mjs";
import { render402vStyles } from "./styles.mjs";

function render(input) {
  return Object.freeze({
    lang: input.metadata.lang || "en",
    styles: render402vStyles(input.mode),
    bodyHtml:
      input.mode === "interactive"
        ? renderInteractiveShell(input)
        : renderNoteShell(input),
  });
}

export const theme402v = Object.freeze({
  themeContractVersion: 1,
  id: "402v",
  version: "0.1.0",
  displayName: "402v",
  render,
});

export default theme402v;
