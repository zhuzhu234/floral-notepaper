import type { TFunction } from "i18next";
import type { EditorState, Extension } from "@codemirror/state";
import { Prec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { keymap } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
  autocompletion,
  completionStatus,
  pickedCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import type { CompletionSource } from "@codemirror/autocomplete";
import {
  applyBlockCommand,
  blockPrefixEnd,
  buildBlockCommands,
  findSlashTokenInText,
  matchBlockCommands,
} from "./blockCommands";
import type { SlashToken } from "./blockCommands";
import { startTableGrid } from "./tableGrid";

/**
 * 行首 `/` 块菜单。
 *
 * 用户不需要记 `#`、`| --- |` 这些写法：在行首（列表/引用标记之后也算）
 * 输入 `/` 就会弹出块列表，选中后整行一次性转换成对应的 Markdown。
 * 菜单右侧同时显示该块的语法，用久了自然就会写了。
 *
 * 文档始终只有一份 Markdown 文本，这里只负责"把意图翻译成标记"。
 */

/** 这些节点内部是代码或字面量，不应弹出块菜单 */
const LITERAL_BLOCKS = new Set(["FencedCode", "CodeBlock", "InlineCode", "HTMLBlock", "Comment"]);

export function isInLiteralBlock(state: EditorState, pos: number): boolean {
  // 刚输入的行可能还没被增量解析，按需补一次同步解析
  const tree = syntaxTreeAvailable(state, pos)
    ? syntaxTree(state)
    : ensureSyntaxTree(state, pos, 20);
  if (!tree) return false;

  for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent) {
    if (LITERAL_BLOCKS.has(node.name)) return true;
  }
  return false;
}

/**
 * 光标前的 `/查询`；不在行首块位置或位于代码/字面量内时返回 null。
 *
 * 判断一并做在这里：菜单与 Esc 回删都依赖同一个判定，
 * 分开写容易出现"能弹出却删不掉"的不一致。
 */
export function findSlashToken(state: EditorState, pos: number): SlashToken | null {
  const line = state.doc.lineAt(pos);
  const token = findSlashTokenInText(state.doc.toString(), pos);
  if (!token) return null;
  if (isInLiteralBlock(state, line.from + blockPrefixEnd(line.text))) return null;
  return token;
}

export function slashCompletionSource(getTranslate: () => TFunction): CompletionSource {
  return (context) => {
    if (context.state.readOnly) return null;
    // 输入法合成期间不弹菜单，等文字真正落进文档后再匹配
    if (context.view?.composing) return null;

    const token = findSlashToken(context.state, context.pos);
    if (!token) return null;

    const commands = matchBlockCommands(buildBlockCommands(getTranslate()), token.query);
    if (commands.length === 0) return null;

    return {
      from: token.from,
      to: token.to,
      // 自己按标签/别名完成匹配与排序，不再让内置的模糊匹配二次过滤
      filter: false,
      options: commands.map((command) => ({
        label: command.label,
        detail: command.syntax || undefined,
        apply: (view, completion, from, to) => {
          // 表格先弹网格选尺寸，确认前不动文档
          if (command.id === "table") {
            startTableGrid(view, from, to);
            return;
          }

          const result = applyBlockCommand(
            view.state.doc.toString(),
            from,
            to,
            command.id,
            getTranslate(),
          );
          if (!result) return;

          // 整行一次替换：撤销时是一步，不会出现"撤销一半"的中间态
          view.dispatch({
            changes: result.change,
            selection: { anchor: result.anchor, head: result.head },
            annotations: pickedCompletion.of(completion),
            userEvent: "input.complete",
            scrollIntoView: true,
          });
          view.focus();
        },
      })),
    };
  };
}

/**
 * 工具栏与快捷键共用的入口：在光标处放一个 `/` 并打开菜单。
 * 当前行已有正文时先另起一行，避免把原有文字当成查询。
 */
export function openSlashMenu(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  if (completionStatus(view.state) !== null) return true;

  const head = view.state.selection.main.head;

  // 代码块里 `/` 是普通字符，不拦菜单，原样插入即可
  if (isInLiteralBlock(view.state, head)) {
    view.dispatch({
      changes: { from: head, insert: "/" },
      selection: { anchor: head + 1 },
      userEvent: "input.type",
    });
    return true;
  }

  const line = view.state.doc.lineAt(head);
  const body = line.text.slice(blockPrefixEnd(line.text));
  const insertAt = body.trim().length > 0 ? line.to : line.from + blockPrefixEnd(line.text);
  const insert = body.trim().length > 0 ? "\n/" : "/";

  view.dispatch({
    changes: { from: insertAt, insert },
    selection: { anchor: insertAt + insert.length },
    scrollIntoView: true,
    userEvent: "input.type",
  });

  return startCompletion(view);
}

/**
 * 回删光标前的 `/查询`（菜单取消时使用）。
 * 只依赖 token 判定，不检查菜单状态，便于单独测试。
 */
export function removeSlashToken(view: EditorView): boolean {
  const token = findSlashToken(view.state, view.state.selection.main.head);
  if (!token) return false;

  view.dispatch({
    changes: { from: token.from, to: token.to },
    selection: { anchor: token.from },
    userEvent: "delete",
  });
  return true;
}

/**
 * Esc 关闭菜单并回删 `/查询`，不在文档里留下无意义的斜杠。
 * 菜单没打开时返回 false，把 Esc 让给其他界面（设置面板、右键菜单等）。
 */
export function escapeSlashMenu(view: EditorView): boolean {
  if (completionStatus(view.state) === null) return false;
  return removeSlashToken(view);
}

export function slashMenuExtension(getTranslate: () => TFunction): Extension {
  return [
    // 优先级高于 defaultKeymap 里的 Mod-/（切换注释）与补全自带的 Esc
    Prec.highest(
      keymap.of([
        { key: "Mod-/", run: openSlashMenu },
        { key: "Escape", run: escapeSlashMenu },
      ]),
    ),
    autocompletion({
      override: [slashCompletionSource(getTranslate)],
      icons: false,
      tooltipClass: () => "lp-slash-menu",
      optionClass: () => "lp-slash-option",
    }),
  ];
}
