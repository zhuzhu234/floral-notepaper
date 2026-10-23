import { describe, expect, it } from "vitest";
import { t } from "i18next";
import { EditorState } from "@codemirror/state";
import { applyMarkdownFormat } from "./formatMarkdown";
import type { MarkdownFormatAction } from "./formatMarkdown";
import { SELECTION_SHORTCUTS } from "./selectionActions";

/** 用 `|` 标出选区边界，便于直观书写用例 */
function parse(input: string) {
  const start = input.indexOf("|");
  const rest = input.slice(0, start) + input.slice(start + 1);
  const close = rest.indexOf("|");
  const end = close < 0 ? start : close;
  const value = close < 0 ? rest : rest.slice(0, close) + rest.slice(close + 1);
  return { value, start, end };
}

function run(input: string, action: MarkdownFormatAction) {
  const { value, start, end } = parse(input);
  const result = applyMarkdownFormat(value, start, end, action, t);
  const before = result.value.slice(0, result.selectionStart);
  const selected = result.value.slice(result.selectionStart, result.selectionEnd);
  const after = result.value.slice(result.selectionEnd);
  // 空选区只画一个 `|`
  return { text: selected ? `${before}|${selected}|${after}` : `${before}|${after}`, result };
}

describe("strike formatting", () => {
  it("wraps the selection in double tildes", () => {
    expect(run("前文|删掉|后文", "strike").text).toBe("前文~~|删掉|~~后文");
  });

  it("inserts a placeholder when nothing is selected", () => {
    expect(run("前文|后文", "strike").text).toBe("前文~~|删除线文本|~~后文");
  });
});

describe("link formatting", () => {
  it("turns the selection into link text and puts the caret in the url slot", () => {
    expect(run("见|花笺|官网", "link").text).toBe("见[花笺](|)官网");
  });

  it("selects the placeholder text when nothing is selected", () => {
    expect(run("前文|后文", "link").text).toBe("前文[|链接文字|]()后文");
  });
});

describe("selection shortcuts", () => {
  it("binds every inline action to a distinct key", () => {
    const keys = SELECTION_SHORTCUTS.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers bold, italic, strike, code and link", () => {
    expect(SELECTION_SHORTCUTS.map((item) => item.action)).toEqual([
      "bold",
      "italic",
      "strike",
      "code",
      "link",
    ]);
  });
});

describe("selection toolbar visibility", () => {
  // 浮条只在「单行、非空、可写」选区出现；这里直接验证判定条件
  function shouldShow(doc: string, start: number, end: number, readOnly = false) {
    const state = EditorState.create({
      doc,
      selection: { anchor: start, head: end },
      extensions: [EditorState.readOnly.of(readOnly)],
    });
    const range = state.selection.main;
    if (state.readOnly) return false;
    if (range.empty) return false;
    return state.doc.lineAt(range.from).number === state.doc.lineAt(range.to).number;
  }

  it("shows for a non-empty selection on one line", () => {
    expect(shouldShow("这是正文", 0, 2)).toBe(true);
  });

  it("hides for a collapsed cursor", () => {
    expect(shouldShow("这是正文", 1, 1)).toBe(false);
  });

  it("hides for a selection spanning lines", () => {
    expect(shouldShow("第一行\n第二行", 0, 5)).toBe(false);
  });

  it("hides in read-only documents", () => {
    expect(shouldShow("这是正文", 0, 2, true)).toBe(false);
  });
});
