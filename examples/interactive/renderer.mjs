function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

export function renderArtifact({ data }) {
  const cards = data.dashboard.items.map((item) =>
    `<article><h2>${escapeHtml(item.label)}</h2><p>${escapeHtml(item.value)}</p></article>`
  ).join("");
  return {
    navigation: '<nav aria-label="Example navigation"><a href="#overview">Dashboard</a></nav>',
    heroSupplementary: `<p>Dataset status: <strong>${escapeHtml(data.dashboard.status)}</strong></p>`,
    mainSections: `<section id="overview"><h2>Offline dashboard</h2><div class="example-grid">${cards}</div></section>`,
    rail: '<aside><p>This artifact reads its embedded data through the neutral runtime.</p></aside>',
    footer: "<p>Built and verified locally.</p>",
  };
}
