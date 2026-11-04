import { afterAll, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMarkdownRenderer,
  disposeMdItInstance,
  resolveConfig as resolveDocumentationConfiguration,
} from "vitepress";
import { resolveConfig as resolveTestConfiguration } from "vitest/node";
import {
  sidebarRoutes,
  coverageDocumentationFailures,
} from "../architecture/configuration-surface.mjs";
import { documentationTarget, MarkdownDocument } from "../architecture/markdown-document.mjs";

const renderer = await createMarkdownRenderer("docs");
afterAll(() => disposeMdItInstance());

it("resolves site-root and relative Markdown links to the same document", () => {
  for (const target of [
    "./guide/platform.md",
    "/guide/platform.md",
    "/guide/platform?from=home#activation",
  ])
    expect(documentationTarget("docs/index.md", target)).toBe("/docs/guide/platform.md");
  expect(documentationTarget("docs/en/index.md", "./guide/platform.md")).toBe(
    "/docs/en/guide/platform.md",
  );
  expect(documentationTarget("docs/reference/errors.md", "#failure")).toBe(
    "/docs/reference/errors.md",
  );
  expect(
    documentationTarget("docs/index.md", "https://example.test/guide/platform.md"),
  ).toBeUndefined();
});

it("checks the resolved sidebar rather than unused link declarations", async () => {
  const root = mkdtempSync(join(tmpdir(), "dougong-navigation-"));
  try {
    const directory = join(root, ".vitepress");
    mkdirSync(directory);
    writeFileSync(
      join(directory, "config.mts"),
      `
      const unused = () => [{ text: "Guide", link: "/guide/start" }];
      export default { locales: {
        root: { lang: "zh-CN", themeConfig: { sidebar: [] } },
        en: { lang: "en", themeConfig: { sidebar: [] } }
      } };
    `,
    );
    const configuration = await resolveDocumentationConfiguration(root, "build", "production");
    for (const locale of ["root", "en"]) {
      const sidebar = configuration.site.locales[locale].themeConfig.sidebar;
      expect(sidebarRoutes(sidebar, "/guide/start").has("/guide/start")).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("selects the applicable sidebar and honors nested link bases", () => {
  const sidebar = {
    "/guide/": { base: "/guide/", items: [{ link: "start" }] },
    "/guide/advanced/": [{ base: "/guide/advanced/", items: [{ link: "/ownership.md#rules" }] }],
  };
  expect([...sidebarRoutes(sidebar, "/guide/start")]).toEqual(["/guide/start"]);
  expect([...sidebarRoutes(sidebar, "/guide/advanced/ownership")]).toEqual([
    "/guide/advanced/ownership",
  ]);
  expect([...sidebarRoutes(sidebar, "/reference/core")]).toEqual([]);
});

it.each([
  ["93.5", 93.5, true],
  ["90 + 3", 93, false],
])(
  "compares the resolved coverage expression %s without lexical guesses",
  async (expression, value, differs) => {
    const root = mkdtempSync(join(tmpdir(), "dougong-coverage-"));
    try {
      const configFile = join(root, "vitest.config.mjs");
      writeFileSync(
        configFile,
        `export default { test: { coverage: { thresholds: {
      "packages/dougong/src/**": { statements: ${expression}, branches: 86, functions: 96, lines: 96 }
    } } } };`,
      );
      const configuration = await resolveTestConfiguration({ root, configFile });
      const thresholds = configuration.test.coverage.thresholds;
      expect(thresholds["packages/dougong/src/**"].statements).toBe(value);
      const document = new MarkdownDocument(
        renderer,
        [
          "| Package | Statements | Branches | Functions | Lines |",
          "| --- | --- | --- | --- | --- |",
          "| dougong | 93 | 86 | 96 | 96 |",
        ].join("\n"),
        {},
      );
      expect(coverageDocumentationFailures(thresholds, "packages/dougong", document)).toEqual(
        differs ? ["coverage row for dougong differs from vitest.config.ts"] : [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
