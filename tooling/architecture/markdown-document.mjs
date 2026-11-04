import { posix } from "node:path";

const scriptLanguage = /^(?:[cm]?[jt]sx?|typescript|javascript)\b/i;

export function documentationTarget(documentPath, target) {
  if (URL.canParse(target) || target.startsWith("//")) return undefined;
  const pathname = decodeURIComponent(target.split(/[?#]/, 1)[0]);
  const path = !pathname
    ? posix.resolve("/", documentPath)
    : pathname.startsWith("/")
      ? posix.resolve("/docs", `.${pathname}`)
      : posix.resolve("/", posix.dirname(documentPath), pathname);
  if (pathname.endsWith("/")) return posix.join(path, "index.md");
  const extension = posix.extname(path);
  if (!extension) return `${path}.md`;
  if (extension === ".html") return `${path.slice(0, -extension.length)}.md`;
  return extension === ".md" ? path : undefined;
}

export class MarkdownDocument {
  #tokens;

  constructor(renderer, source, environment) {
    this.#tokens = renderer.parse(source, environment);
  }

  scriptBlocks() {
    return this.#tokens
      .filter((token) => token.type === "fence" && scriptLanguage.test(token.info.trim()))
      .map((token) => token.content);
  }

  codeFragments() {
    return this.#tokens.flatMap((token) => {
      if (
        token.type === "fence" &&
        (scriptLanguage.test(token.info.trim()) || /^json\b/i.test(token.info.trim()))
      )
        return [token.content];
      return (token.children ?? [])
        .filter((child) => child.type === "code_inline")
        .map((child) => child.content);
    });
  }

  links() {
    const links = [];
    for (const token of this.#tokens) {
      let link;
      for (const child of token.children ?? []) {
        if (child.type === "link_open") link = { target: child.attrGet("href"), codes: [] };
        else if (child.type === "link_close") {
          links.push(link);
          link = undefined;
        } else if (link && child.type === "code_inline") link.codes.push(child.content);
      }
    }
    return links;
  }

  tableRows() {
    const rows = [];
    let row;
    for (const token of this.#tokens) {
      if (token.type === "tr_open") row = [];
      else if (token.type === "tr_close") {
        rows.push(row);
        row = undefined;
      } else if (row && token.type === "inline") {
        const children = token.children ?? [];
        row.push({
          text: children.map((child) => child.content).join(""),
          codes: children
            .filter((child) => child.type === "code_inline")
            .map((child) => child.content),
        });
      }
    }
    return rows;
  }
}
