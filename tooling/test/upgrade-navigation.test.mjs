import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { publishedDirectories } from "../packages.mjs";

const workspace = new URL("../../", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, workspace), "utf8");
}

it("exposes stable upgrade navigation from READMEs and documentation", () => {
  const entries = [
    ["README.md", "./docs/guide/upgrading.md"],
    ["README.en.md", "./docs/en/guide/upgrading.md"],
    ...publishedDirectories.map((directory) => [
      `${directory}/README.md`,
      "https://tangerg.github.io/dougong/en/guide/upgrading",
    ]),
  ];
  for (const [file, target] of entries) {
    const source = read(file);
    expect(source).toContain(`](${target})`);
  }
  for (const homepage of ["docs/index.md", "docs/en/index.md"])
    expect(read(homepage)).toContain("](./guide/upgrading.md)");
  const sidebar = read("docs/.vitepress/config.mts");
  expect(sidebar).toContain('link: "/guide/upgrading"');
  expect(sidebar).toContain('link: "/en/guide/upgrading"');
});

it.each(["docs/", "docs/en/"])("%s indexes every documented migration and release", (directory) => {
  const expected = [
    ...readdirSync(new URL(`${directory}guide/`, workspace))
      .filter((file) => /^migrating-to-.*\.md$/.test(file))
      .map((file) => `./${file}`),
    ...readdirSync(new URL(`${directory}reference/`, workspace))
      .filter((file) => /^release-.*\.md$/.test(file))
      .map((file) => `../reference/${file}`),
  ];
  const links = [...read(`${directory}guide/upgrading.md`).matchAll(/\]\(([^)]+)\)/g)].map(
    ([, target]) => target,
  );
  expect(links.sort()).toEqual(expected.sort());
});
