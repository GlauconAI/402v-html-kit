import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assembleArtifactV2,
  renderThemeV1,
} from "../../packages/core/src/index.mjs";
import theme402v from "../../packages/theme-402v/src/index.mjs";
import {
  CdpConnection,
  launchChrome,
  stopChrome,
} from "./chrome-harness.mjs";

type CdpEvent = {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

const wideSvg = '<div class="artifact-svg-frame"><svg class="artifact-svg" width="1200" height="240" viewBox="0 0 1200 240" role="img" aria-labelledby="wide-title"><title id="wide-title">Wide chart</title><rect width="1200" height="240"/></svg></div>';
const metadata = {
  title: "A-very-long-402v-artifact-title-that-must-remain-inside-the-mobile-viewport",
  description: "Offline browser acceptance",
  eyebrow: "402v theme",
  lang: "en",
};

function documentFor(mode: "note" | "interactive") {
  const content = mode === "note"
    ? {
        articleHtml: `<article><h2 id="chart">Chart</h2>${wideSvg}</article>`,
        headings: [{ id: "chart", level: 2, text: "Chart" }],
      }
    : {
        slots: {
          navigation: '<a href="#chart">Chart</a>',
          heroSupplementary: "",
          mainSections: `<section id="chart"><h2>Chart</h2>${wideSvg}</section>`,
          rail: "",
          footer: "",
        },
        svg: {
          wide: { id: "wide", label: "wide.svg", html: wideSvg },
        },
      };
  const themeOutput = renderThemeV1(theme402v, { mode, metadata, content });
  return assembleArtifactV2({
    mode,
    metadata,
    theme: { id: theme402v.id, version: theme402v.version },
    themeOutput,
    dataBlocks: new Map(),
    consumerScripts: [],
  });
}

async function inspectDocument(
  connection: CdpConnection,
  html: string,
  viewport: { width: number; height: number },
) {
  const { targetId } = await connection.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await connection.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const networkRequests: string[] = [];
  const pageErrors: string[] = [];
  const stopListening = connection.onEvent((event) => {
    if (event.sessionId !== sessionId) return;
    if (event.method === "Network.requestWillBeSent") {
      const request = event.params?.request as { url?: string } | undefined;
      networkRequests.push(request?.url ?? "unknown request");
    }
    if (event.method === "Runtime.exceptionThrown") {
      pageErrors.push(JSON.stringify(event.params));
    }
    if (event.method === "Log.entryAdded") {
      const entry = event.params?.entry as { level?: string; text?: string } | undefined;
      if (entry?.level === "error") pageErrors.push(entry.text ?? "page log error");
    }
    if (event.method === "Runtime.consoleAPICalled") {
      const type = event.params?.type;
      if (type === "error" || type === "assert") {
        pageErrors.push(`console.${String(type)}`);
      }
    }
  });

  try {
    await Promise.all([
      connection.send("Page.enable", {}, sessionId),
      connection.send("Runtime.enable", {}, sessionId),
      connection.send("Network.enable", {}, sessionId),
      connection.send("Log.enable", {}, sessionId),
    ]);
    await connection.send(
      "Emulation.setDeviceMetricsOverride",
      { ...viewport, deviceScaleFactor: 1, mobile: viewport.width <= 390 },
      sessionId,
    );
    const frameTree = await connection.send("Page.getFrameTree", {}, sessionId);
    await connection.send(
      "Page.setDocumentContent",
      { frameId: frameTree.frameTree.frame.id, html },
      sessionId,
    );
    const evaluation = await connection.send(
      "Runtime.evaluate",
      {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const root = document.documentElement;
          const body = document.body;
          const viewportWidth = root.clientWidth;
          const frames = [...document.querySelectorAll('.artifact-svg-frame')];
          return {
            contract: document.querySelector('meta[name="html-kit-artifact-contract"]')?.getAttribute('content'),
            pageScrollWidth: Math.max(root.scrollWidth, body.scrollWidth),
            viewportWidth,
            svgCount: document.querySelectorAll('svg').length,
            svgContained: frames.length > 0 && frames.every((frame) => {
              const frameRect = frame.getBoundingClientRect();
              return frameRect.left >= -0.5 && frameRect.right <= viewportWidth + 0.5 &&
                [...frame.querySelectorAll('svg')].every((svg) => {
                  const svgRect = svg.getBoundingClientRect();
                  return svgRect.left >= frameRect.left - 0.5 && svgRect.right <= frameRect.right + 0.5;
                });
            }),
          };
        })()`,
      },
      sessionId,
    );
    return {
      metrics: evaluation.result.value as {
        contract: string;
        pageScrollWidth: number;
        viewportWidth: number;
        svgCount: number;
        svgContained: boolean;
      },
      networkRequests,
      pageErrors,
    };
  } finally {
    stopListening();
    await connection.send("Target.closeTarget", { targetId });
  }
}

describe("402v theme browser acceptance", () => {
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;

  beforeAll(async () => {
    browser = await launchChrome();
  }, 20_000);

  afterAll(async () => {
    if (browser === undefined) return;
    await stopChrome(browser);
  });

  it.each([
    ["note", 1280, 900],
    ["note", 390, 844],
    ["interactive", 1280, 900],
    ["interactive", 390, 844],
  ] as const)(
    "renders %s at %sx%s without overflow, errors, or network",
    async (mode, width, height) => {
      if (browser === undefined) throw new Error("Chrome did not start");
      const inspected = await inspectDocument(
        browser.connection,
        documentFor(mode),
        { width, height },
      );

      expect(inspected.metrics.contract).toBe("2");
      expect(inspected.metrics.pageScrollWidth).toBeLessThanOrEqual(
        inspected.metrics.viewportWidth,
      );
      expect(inspected.metrics.svgCount).toBeGreaterThan(0);
      expect(inspected.metrics.svgContained).toBe(true);
      expect(inspected.pageErrors).toEqual([]);
      expect(inspected.networkRequests).toEqual([]);
    },
    20_000,
  );
});
