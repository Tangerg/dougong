import { posix } from "node:path";

export function sidebarRoutes(sidebar, page) {
  let selected = sidebar;
  if (selected && !Array.isArray(selected)) {
    const prefix = Object.keys(selected)
      .sort((left, right) => right.split("/").length - left.split("/").length)
      .find((key) => page.startsWith(key.startsWith("/") ? key : `/${key}`));
    selected = prefix === undefined ? undefined : selected[prefix];
  }
  const routes = new Set();
  const visit = (items, inheritedBase = "") => {
    for (const item of items) {
      const base = item.base || inheritedBase;
      const link = item.link;
      if (typeof link === "string" && !URL.canParse(link) && !link.startsWith("//")) {
        const target = base ? base + link.replace(/^\//, base.endsWith("/") ? "" : "/") : link;
        routes.add(posix.resolve("/", target.split(/[?#]/, 1)[0]).replace(/\.md$/, ""));
      }
      if (item.items) visit(item.items, base);
    }
  };
  if (Array.isArray(selected)) visit(selected);
  else if (selected) visit(selected.items, selected.base);
  return routes;
}

const coverageMetrics = ["statements", "branches", "functions", "lines"];

export function coverageDocumentationFailures(thresholds, directory, document) {
  const values = thresholds?.[`${directory}/src/**`];
  const packageName = posix.basename(directory);
  if (!values || coverageMetrics.some((metric) => !Number.isFinite(values[metric]))) {
    return [`vitest.config.ts: cannot derive ${packageName} coverage thresholds`];
  }
  const expected = [packageName, ...coverageMetrics.map((metric) => String(values[metric]))];
  const matches = document
    .tableRows()
    .some(
      (row) =>
        row.length === expected.length &&
        row.every((cell, index) => cell.text.trim() === expected[index]),
    );
  return matches ? [] : [`coverage row for ${packageName} differs from vitest.config.ts`];
}
