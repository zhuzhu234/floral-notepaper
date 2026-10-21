import { describe, expect, it } from "vitest";
import { t } from "i18next";
import { applyMarkdownFormat } from "./formatMarkdown";

/** 用 `|` 标记选区边界，便于直观表达"选中了什么"；单个 `|` 表示空选区（光标） */
function parse(input: string) {
  const start = input.indexOf("|");
  const rest = input.slice(0, start) + input.slice(start + 1);
  const close = rest.indexOf("|");
  const end = close < 0 ? start : close;
  const value = close < 0 ? rest : rest.slice(0, close) + rest.slice(close + 1);
  return { value, start, end };
}

function run(input: string, action: Parameters<typeof applyMarkdownFormat>[3]) {
  const { value, start, end } = parse(input);
  const result = applyMarkdownFormat(value, start, end, action, t);
  const before = result.value.slice(0, result.selectionStart);
  const selected = result.value.slice(result.selectionStart, result.selectionEnd);
  const after = result.value.slice(result.selectionEnd);
  // 空选区只画一个 `|`
  return selected ? `${before}|${selected}|${after}` : `${before}|${after}`;
}

describe("applyMarkdownFormat", () => {
  it("wraps the selection in bold markers and keeps it selected", () => {
    expect(run("前文|粗体|后文", "bold")).toBe("前文**|粗体|**后文");
  });

  it("inserts placeholder text inside the markers when nothing is selected", () => {
    expect(run("前文|后文", "bold")).toBe("前文**|粗体文本|**后文");
  });

  it("wraps the selection in italic markers", () => {
    expect(run("|斜体|", "italic")).toBe("*|斜体|*");
  });

  it("cycles heading levels on the current line", () => {
    expect(run("|标题|", "heading")).toBe("## |标题|");
    expect(run("## |标题|", "heading")).toBe("### |标题|");
    expect(run("##### |标题|", "heading")).toBe("# |标题|");
  });

  it("adds a horizontal rule with surrounding newlines only when needed", () => {
    // 光标停在 `---` 之后，紧接原文
    expect(run("前文|后文", "hr")).toBe("前文\n---|\n后文");
  });

  it("prefixes every selected line for unordered lists", () => {
    expect(run("|一\n二|", "ul")).toBe("|- 一\n- 二|");
  });

  it("numbers each selected line for ordered lists", () => {
    expect(run("|一\n二|", "ol")).toBe("|1. 一\n2. 二|");
  });

  it("uses a fenced block for multi-line code selections", () => {
    expect(run("|a\nb|", "code")).toBe("```\n|a\nb|\n```");
  });

  it("keeps the closing fence on its own line when text follows", () => {
    // 围栏必须独占一行，否则后面的文字会被当成代码
    expect(run("|a\nb|后文", "code")).toBe("```\n|a\nb|\n```\n后文");
  });

  it("puts a fenced block on its own line after preceding text", () => {
    expect(run("前文|a\nb|", "code")).toBe("前文\n```\n|a\nb|\n```");
  });

  it("uses inline code for single-line selections", () => {
    expect(run("|x|", "code")).toBe("`|x|`");
  });

  it("prefixes each selected line for quotes", () => {
    expect(run("|一\n二|", "quote")).toBe("|> 一\n> 二|");
  });

  it("wraps inline math in single dollars", () => {
    expect(run("|E=mc^2|", "inlineMath")).toBe("$|E=mc^2|$");
  });

  it("inserts a display math block", () => {
    expect(run("|", "blockMath")).toBe("\n$$\n|x^2 + y^2 = r^2|\n$$\n");
  });
});
