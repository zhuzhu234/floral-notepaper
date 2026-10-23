import { describe, expect, it } from "vitest";
import { t } from "i18next";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { TABLE_MAX_COLUMNS } from "./blockCommands";
import {
  cancelTableGrid,
  confirmTableGrid,
  setTableGridSize,
  startTableGrid,
  stepTableGrid,
  tableGridExtension,
  tableGridSize,
} from "./tableGrid";

/**
 * 网格的每一步都只是状态迁移，不需要真实 DOM。
 * 用极小的 view 替身承载 dispatch，验证"打开 → 调尺寸 → 确认"的文档结果。
 */
function createHarness(doc: string, cursor = doc.length) {
  let state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [tableGridExtension(() => t)],
  });

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

describe("table grid state", () => {
  it("starts at 2 × 2 and leaves the document untouched", () => {
    const harness = createHarness("/表格");
    startTableGrid(harness.view, 0, 3);
    expect(tableGridSize(harness.state)).toEqual({ columns: 2, rows: 2 });
    expect(harness.doc).toBe("/表格");
  });

  it("updates the previewed size", () => {
    const harness = createHarness("/表格");
    startTableGrid(harness.view, 0, 3);
    setTableGridSize(harness.view, 4, 3);
    expect(tableGridSize(harness.state)).toEqual({ columns: 4, rows: 3 });
  });

  it("clamps to the grid limits", () => {
    const harness = createHarness("/表格");
    startTableGrid(harness.view, 0, 3);
    setTableGridSize(harness.view, 99, 0);
    expect(tableGridSize(harness.state)).toEqual({
      columns: TABLE_MAX_COLUMNS,
      rows: 1,
    });
  });

  it("stops at the edge instead of wrapping around", () => {
    const harness = createHarness("/表格");
    startTableGrid(harness.view, 0, 3);
    expect(stepTableGrid(harness.view, -1, 0)).toBe(true);
    expect(tableGridSize(harness.state)).toEqual({ columns: 1, rows: 2 });
    stepTableGrid(harness.view, -1, -1);
    expect(tableGridSize(harness.state)).toEqual({ columns: 1, rows: 1 });
  });

  it("closes when the document changes", () => {
    const harness = createHarness("/表格");
    startTableGrid(harness.view, 0, 3);
    harness.view.dispatch({ changes: { from: 3, insert: "x" } });
    expect(tableGridSize(harness.state)).toBeNull();
  });

  it("ignores size updates while closed", () => {
    const harness = createHarness("正文");
    expect(setTableGridSize(harness.view, 3, 3)).toBe(false);
    expect(stepTableGrid(harness.view, 1, 1)).toBe(false);
  });
});

describe("confirming and cancelling the grid", () => {
  it("inserts the chosen size and selects the first header placeholder", () => {
    const harness = createHarness("/表格");
    startTableGrid(harness.view, 0, 3);
    setTableGridSize(harness.view, 3, 2);
    expect(confirmTableGrid(harness.view, t)).toBe(true);

    expect(harness.doc).toBe(
      "| 列 1 | 列 2 | 列 3 |\n" + "| --- | --- | --- |\n" + "| 内容 | 内容 | 内容 |\n",
    );
    const { from, to } = harness.state.selection.main;
    expect(harness.doc.slice(from, to)).toBe("列 1");
    expect(tableGridSize(harness.state)).toBeNull();
  });

  it("keeps the body that followed the slash command", () => {
    const harness = createHarness("/表格 说明", 3);
    startTableGrid(harness.view, 0, 3);
    confirmTableGrid(harness.view, t);
    expect(harness.doc.startsWith("说明\n\n| 列 1 |")).toBe(true);
  });

  it("preserves line indentation", () => {
    const harness = createHarness("    /表格");
    startTableGrid(harness.view, 4, 7);
    confirmTableGrid(harness.view, t);
    expect(harness.doc.split("\n")[0]).toBe("    | 列 1 | 列 2 |");
  });

  it("removes the slash command when cancelled", () => {
    const harness = createHarness("/表格");
    startTableGrid(harness.view, 0, 3);
    expect(cancelTableGrid(harness.view)).toBe(true);
    expect(harness.doc).toBe("");
    expect(tableGridSize(harness.state)).toBeNull();
  });
});
