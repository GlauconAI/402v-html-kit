export function renderNoteShell({ metadata, content }) {
  const title = escapeHtml(metadata.title);
  const description = escapeHtml(metadata.description);
  const eyebrow = escapeHtml(metadata.eyebrow);
  const slug = escapeHtml(slugify(metadata.title));
  const articleHtml = content.articleHtml ?? "";
  const navigation = (content.headings ?? [])
    .filter((heading) => heading.level === 2 || heading.level === 3)
    .map(
      (heading) =>
        `<li class="toc-level-${heading.level}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`,
    )
    .join("");

  return `  <header class="artifact-topbar">
    <div class="artifact-topbar-inner">
      <a class="artifact-brand" href="https://402v.com">402v</a>
      <span class="artifact-path">~/sites/${slug}</span>
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
    </header>
    <div class="artifact-layout">
      <main class="artifact-main-panel">
        <article class="note-article">${articleHtml}</article>
        <footer class="note-footer">402v HTML Note Kit · standalone HTML</footer>
      </main>
      <aside class="artifact-rail" aria-label="Artifact information">
        ${navigation ? `<nav class="artifact-rail-panel note-toc" aria-label="Table of contents"><strong>Contents</strong><ol>${navigation}</ol></nav>` : ""}
        <section class="artifact-rail-panel artifact-meta">
          <h2>Artifact</h2>
          <dl>
            <div><dt>format</dt><dd>HTML</dd></div>
            <div><dt>layout</dt><dd>402v / note</dd></div>
            <div><dt>delivery</dt><dd>local · 402v</dd></div>
          </dl>
        </section>
      </aside>
    </div>
  </div>`;
}

export function slugify(value) {
  const slug = String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "html-artifact";
}

export function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
