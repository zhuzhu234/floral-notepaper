import { describe, expect, it } from "vitest";
import { t } from "i18next";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CompletionContext } from "@codemirror/autocomplete";
import type { Completion, CompletionResult } from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { livePreviewMarkdown } from "./livePreviewLanguage";
import { slashCompletionSource, slashMenuExtension, removeSlashToken } from "./slashMenu";

/**
 * 这些用例不需要真实 DOM：补全源与 apply 只依赖 state / dispatch。
 * 用一个极小的 view 替身承载状态迁移，足以覆盖"菜单给出什么、选中后文档变成什么"。
 */
function createHarness(doc: string, cursor = doc.length) {
  let state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [livePreviewMarkdown, slashMenuExtension(() => t)],
  });
  ensureSyntaxTree(state, doc.length, 1000);

  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    },
    focus() {},
  } as unknown as EditorView;

  return {
    view,
    get state() {
      return state;
    },
    get doc() {
      return state.doc.toString();
    },
  };
}

function query(doc: string, cursor = doc.length): CompletionResult | null {
  const harness = createHarness(doc, cursor);
  const context = new CompletionContext(harness.state, cursor, true);
  return slashCompletionSource(() => t)(context) as CompletionResult | null;
}

function applyOption(doc: string, option: Completion, from: number, to: number) {
  const harness = createHarness(doc);
  const apply = option.apply;
  if (typeof apply !== "function") throw new Error("expected a function apply");
  apply(harness.view, option, from, to);
  return harness;
}

describe("slash completion source", () => {
  it("offers every block for a bare slash", () => {
    const result = query("/");
    expect(result).not.toBeNull();
    expect(result!.from).toBe(0);
    expect(result!.options.map((option) => option.label)).toContain("表格");
  });

  it("filters by the text typed after the slash", () => {
    const result = query("/表格");
    expect(result!.options.map((option) => option.label)).toEqual(["表格"]);
  });

  it("keeps partial matches so users can stop typing early", () => {
    // `表` 同时是「表格」的前缀和「无序列表 / 有序列表」的别名片段
    const labels = query("/表")!.options.map((option) => option.label);
    expect(labels[0]).toBe("表格");
    expect(labels.length).toBeGreaterThan(1);
  });

  it("filters by English aliases", () => {
    const result = query("/todo");
    expect(result!.options.map((option) => option.label)).toEqual(["待办事项"]);
  });

  it("attaches the Markdown syntax as the option detail", () => {
    const result = query("/task");
    expect(result!.options[0].detail).toBe("- [ ]");
  });

  it("shows the menu after list markers", () => {
    expect(query("- /")?.from).toBe(2);
  });

  it("stays quiet in the middle of a sentence", () => {
    expect(query("正文 /表")).toBeNull();
  });

  it("stays quiet inside a code block", () => {
    expect(query("```\n/tab\n```", 5)).toBeNull();
  });

  it("stays quiet for a query that matches no block", () => {
    expect(query("/zzz")).toBeNull();
  });
});

describe("applying a slash command", () => {
  it("replaces the whole line in one transaction", () => {
    const result = query("/h2")!;
    const harness = applyOption("/h2", result.options[0], result.from, 3);
    expect(harness.doc).toBe("## ");
  });

  it("opens the size grid instead of inserting the table right away", () => {
    const result = query("/表格")!;
    const harness = applyOption("/表格", result.options[0], result.from, 3);
    // 表格要等网格确认尺寸后才落笔，这一步文档应保持原样
    expect(harness.doc).toBe("/表格");
  });

  it("keeps the text that was already on the line", () => {
    // `/quote` 之后跟的是正文，而不是查询：光标停在斜杠命令末尾
    const doc = "/quote 正文";
    const result = query(doc, 6)!;
    const harness = applyOption(doc, result.options[0], result.from, result.to!);
    expect(harness.doc).toBe("> 正文");
  });
});

describe("removeSlashToken", () => {
  it("removes the typed slash", () => {
    const harness = createHarness("/表", 2);
    expect(removeSlashToken(harness.view)).toBe(true);
    expect(harness.doc).toBe("");
  });

  it("does nothing when there is no slash token", () => {
    const harness = createHarness("正文", 2);
    expect(removeSlashToken(harness.view)).toBe(false);
    expect(harness.doc).toBe("正文");
  });
});
