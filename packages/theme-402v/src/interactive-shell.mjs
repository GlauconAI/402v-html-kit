import { escapeHtml, slugify } from "./note-shell.mjs";

export function renderInteractiveShell({ metadata, content }) {
  const title = escapeHtml(metadata.title);
  const description = escapeHtml(metadata.description);
  const eyebrow = escapeHtml(metadata.eyebrow);
  const slug = escapeHtml(slugify(metadata.title));
  const slots = content.slots ?? {};

  return `  <header class="artifact-topbar">
    <div class="artifact-topbar-inner">
      <a class="artifact-brand" href="https://402v.com">402v</a>
      <span class="artifact-path">~/sites/${slug}</span>
      <div class="artifact-navigation-slot">${slots.navigation ?? ""}</div>
      <span class="artifact-topbar-status">artifact: standalone</span>
    </div>
  </header>
  <div class="artifact-shell">
    <header class="artifact-hero">
      <p class="note-eyebrow">${eyebrow}</p>
      <h1>${title}</h1>
      ${description ? `<p class="note-description">&gt; ${description}</p>` : ""}
      <div class="artifact-status" aria-label="Artifact status">
        <span>status: ready</span>
        <span>target: 402v</span>
        <span>runtime: offline</span>
      </div>
      ${slots.heroSupplementary ?? ""}
    </header>
    <div class="artifact-layout">
      <main class="artifact-main-panel">
        ${slots.mainSections ?? ""}
        <footer class="note-footer">${slots.footer ?? ""}402v HTML Note Kit · standalone HTML</footer>
      </main>
      <aside class="artifact-rail" aria-label="Artifact information">
        ${slots.rail ?? ""}
        <section class="artifact-rail-panel artifact-meta">
          <h2>Artifact</h2>
          <dl>
            <div><dt>format</dt><dd>HTML</dd></div>
            <div><dt>layout</dt><dd>402v / interactive</dd></div>
            <div><dt>delivery</dt><dd>local · 402v</dd></div>
          </dl>
        </section>
      </aside>
    </div>
  </div>`;
}
