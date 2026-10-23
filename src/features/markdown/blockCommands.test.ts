import { describe, expect, it } from "vitest";
import { t } from "i18next";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import {
  applyBlockCommand,
  buildBlockCommands,
  buildTableBlock,
  matchBlockCommands,
} from "./blockCommands";
import { livePreviewMarkdown } from "./livePreviewLanguage";
import { findSlashToken } from "./slashMenu";

/**
 * 用 `|` 标出 `/查询` 的起点；可选的第二个 `|` 标出光标，
 * 省略时光标位于行尾。
 */
function parse(input: string) {
  const from = input.indexOf("|");
  const rest = input.slice(0, from) + input.slice(from + 1);
  const close = rest.indexOf("|");
  if (close < 0) return { doc: rest, from, to: rest.length };
  return { doc: rest.slice(0, close) + rest.slice(close + 1), from, to: close };
}

function run(input: string, id: Parameters<typeof applyBlockCommand>[3]) {
  const { doc, from, to } = parse(input);
  const result = applyBlockCommand(doc, from, to, id, t);
  if (!result) throw new Error("expected a block command result");

  const { from: changeFrom, to: changeTo, insert } = result.change;
  const next = doc.slice(0, changeFrom) + insert + doc.slice(changeTo);
  const before = next.slice(0, result.anchor);
  const selected = next.slice(result.anchor, result.head);
  return { next, caret: `${before}|${selected}` };
}

describe("matchBlockCommands", () => {
  // 命令标签走 i18n，必须在 i18n 初始化（beforeAll）之后再构建
  const commands = () => buildBlockCommands(t);

  it("returns every command for an empty query", () => {
    expect(matchBlockCommands(commands(), "")).toHaveLength(commands().length);
  });

  it("matches localized labels", () => {
    expect(matchBlockCommands(commands(), "表格")[0].id).toBe("table");
  });

  it("matches English and pinyin aliases", () => {
    expect(matchBlockCommands(commands(), "table")[0].id).toBe("table");
    expect(matchBlockCommands(commands(), "biaoge")[0].id).toBe("table");
  });

  it("prefers exact matches over partial ones", () => {
    expect(matchBlockCommands(commands(), "hr")[0].id).toBe("hr");
  });

  it("returns nothing when no command matches", () => {
    expect(matchBlockCommands(commands(), "zzzz")).toEqual([]);
  });
});

describe("buildTableBlock", () => {
  it("builds the header, separator and body rows for the requested size", () => {
    const { text } = buildTableBlock({ columns: 3, rows: 3 }, "", t);
    expect(text).toBe(
      "| 列 1 | 列 2 | 列 3 |\n" +
        "| --- | --- | --- |\n" +
        "| 内容 | 内容 | 内容 |\n" +
        "| 内容 | 内容 | 内容 |\n",
    );
  });

  it("treats rows as including the header", () => {
    const { text } = buildTableBlock({ columns: 2, rows: 1 }, "", t);
    expect(text.split("\n")).toHaveLength(3);
    expect(text).not.toContain("| 内容 |");
  });

  it("clamps sizes to the grid limits", () => {
    const { text } = buildTableBlock({ columns: 0, rows: 0 }, "", t);
    expect(text).toBe("| 列 1 |\n| --- |\n");
  });

  it("indents every line and reports offsets relative to the text", () => {
    const { text, headerStart, headerLength } = buildTableBlock({ columns: 2, rows: 2 }, "  ", t);
    expect(text.split("\n")[0]).toBe("  | 列 1 | 列 2 |");
    expect(text.slice(headerStart, headerStart + headerLength)).toBe("列 1");
  });
});

describe("applyBlockCommand", () => {
  it("turns an empty line into a heading and keeps the caret after the marker", () => {
    const { next, caret } = run("|/h1", "h1");
    expect(next).toBe("# ");
    expect(caret).toBe("# |");
  });

  it("keeps existing text when converting the line", () => {
    expect(run("|/ |正文", "h2").next).toBe("## 正文");
  });

  it("replaces an existing marker instead of stacking a second one", () => {
    expect(run("# |/h3", "h3").next).toBe("### ");
  });

  it("preserves the outer nesting of a quote list", () => {
    expect(run("> - |/h2", "h2").next).toBe("> ## ");
  });

  it("strips markers when converting back to plain text", () => {
    expect(run("## |/text", "text").next).toBe("");
    expect(run("- [ ] |/text", "text").next).toBe("");
  });

  it("keeps indentation for nested content", () => {
    expect(run("    |/task", "task").next).toBe("    - [ ] ");
  });

  it("inserts a horizontal rule and separates it from preceding text", () => {
    expect(run("正文\n|/hr", "hr").next).toBe("正文\n\n---");
  });

  it("keeps the body above the rule when the line has text", () => {
    expect(run("|/hr|后文", "hr").next).toBe("后文\n\n---");
  });

  it("expands a code block and puts the caret on the empty code line", () => {
    expect(run("|/code", "code").next).toBe("```\n\n```\n");
  });

  it("expands a table and selects the first header placeholder", () => {
    const { next, caret } = run("|/table", "table");
    expect(next).toBe("| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n");
    // 占位符处于选中状态，直接输入即可覆盖
    expect(caret).toBe("| |列 1");
  });

  it("honours an explicit table size", () => {
    const result = applyBlockCommand("/表格", 0, 3, "table", t, {
      tableSize: { columns: 3, rows: 2 },
    });
    if (!result) throw new Error("expected a block command result");
    expect(result.change.insert).toContain("| 列 1 | 列 2 | 列 3 |");
    expect(result.change.insert).toContain("| 内容 | 内容 | 内容 |");
  });

  it("uses the body as the formula when a display block is requested", () => {
    expect(run("|/math", "math").next).toBe("$$\nx^2 + y^2 = r^2\n$$\n");
    // 光标停在 `/math` 之后，行内剩余文字作为公式内容
    expect(run("|/math| a+b", "math").next).toBe("$$\na+b\n$$\n");
  });

  it("consumes the trailing newline so multi-line blocks do not leave a blank line", () => {
    // 多行用例直接构造区间：`/code` 位于首行行尾，光标也停在那里
    const doc = "/code\n下一段";
    const result = applyBlockCommand(doc, 0, 5, "code", t);
    if (!result) throw new Error("expected a block command result");
    const { from, to, insert } = result.change;
    expect(doc.slice(0, from) + insert + doc.slice(to)).toBe("```\n\n```\n下一段");
  });

  it("rejects ranges that spill over the line end", () => {
    expect(applyBlockCommand("/code\n下一段", 0, 10, "code", t)).toBeNull();
  });
});

describe("findSlashToken", () => {
  function at(doc: string, cursor = doc.length) {
    const state = EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [livePreviewMarkdown],
    });
    ensureSyntaxTree(state, doc.length, 1000);
    return findSlashToken(state, cursor);
  }

  it("finds a slash at the start of a line", () => {
    expect(at("/表")).toEqual({ from: 0, to: 2, query: "表" });
  });

  it("finds a slash after list and quote markers", () => {
    expect(at("- /ta")?.query).toBe("ta");
    expect(at("> - /")?.from).toBe(4);
  });

  it("accepts the full-width slash typed with a Chinese IME", () => {
    expect(at("／表格")?.query).toBe("表格");
  });

  it("ignores slashes in the middle of text", () => {
    expect(at("正文 /表")).toBeNull();
  });

  it("ignores slashes inside a fenced code block", () => {
    expect(at("```\n/表\n```", 5)).toBeNull();
  });

  it("ignores slashes in a list item that already has text", () => {
    expect(at("- 正文/表")).toBeNull();
  });
});
