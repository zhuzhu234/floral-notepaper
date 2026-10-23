import type { TFunction } from "i18next";

/**
 * 行首 `/` 菜单可插入的块类型。
 *
 * 这里只做纯文本变换：输入文档、`/查询` 在文档中的区间和命令，输出一次
 * 最小替换（整行替换）以及应用后的光标/选区。不依赖 CodeMirror，
 * 便于直接单测，也能被 textarea 复用。
 */
export type BlockCommandId =
  | "text"
  | "h1"
  | "h2"
  | "h3"
  | "ul"
  | "ol"
  | "task"
  | "quote"
  | "code"
  | "table"
  | "hr"
  | "math";

export interface BlockCommand {
  id: BlockCommandId;
  label: string;
  /** 菜单右侧的语法提示；正文没有标记，留空 */
  syntax: string;
  /** 搜索别名：英文、拼音与缩写，让不熟悉中文标签的用户也能找到 */
  keywords: readonly string[];
}

export interface BlockCommandResult {
  change: { from: number; to: number; insert: string };
  /** 应用后的选区（基于新文档的绝对偏移） */
  anchor: number;
  head: number;
}

/** 网格选择器的上限；超过这个尺寸手写反而更快 */
export const TABLE_MAX_COLUMNS = 8;
export const TABLE_MAX_ROWS = 8;

export interface TableSize {
  columns: number;
  /** 含表头行；值为 1 时只生成表头与分隔行 */
  rows: number;
}

/**
 * 生成表格 Markdown。缩进逐行带，避免整块贴到左侧边距外。
 * 返回的偏移量相对生成文本，供调用方选中第一个表头占位符。
 */
export function buildTableBlock(
  size: TableSize,
  indent: string,
  translate: TFunction,
): { text: string; headerStart: number; headerLength: number } {
  const columns = Math.max(1, Math.min(TABLE_MAX_COLUMNS, size.columns));
  const rows = Math.max(1, Math.min(TABLE_MAX_ROWS, size.rows));
  const cell = translate("main.slash.table.cell", { defaultValue: "内容" });

  const headerCells = Array.from({ length: columns }, (_, index) =>
    translate("main.slash.table.column", {
      index: index + 1,
      defaultValue: `列 ${index + 1}`,
    }),
  );

  const lines = [
    `${indent}| ${headerCells.join(" | ")} |`,
    `${indent}| ${Array.from({ length: columns }, () => "---").join(" | ")} |`,
  ];
  for (let row = 1; row < rows; row++) {
    lines.push(`${indent}| ${Array.from({ length: columns }, () => cell).join(" | ")} |`);
  }
  lines.push("");

  const text = lines.join("\n");
  const headerStart = indent.length + 2;
  return { text, headerStart, headerLength: headerCells[0].length };
}

const ORDER: readonly BlockCommandId[] = [
  "text",
  "h1",
  "h2",
  "h3",
  "ul",
  "ol",
  "task",
  "quote",
  "code",
  "table",
  "hr",
  "math",
];

const SYNTAX: Record<BlockCommandId, string> = {
  text: "",
  h1: "#",
  h2: "##",
  h3: "###",
  ul: "-",
  ol: "1.",
  task: "- [ ]",
  quote: ">",
  code: "```",
  table: "| --- |",
  hr: "---",
  math: "$$",
};

/** 行首标记；正文、分割线与多行块单独处理 */
const MARKERS: Partial<Record<BlockCommandId, string>> = {
  h1: "# ",
  h2: "## ",
  h3: "### ",
  ul: "- ",
  ol: "1. ",
  task: "- [ ] ",
  quote: "> ",
};

const KEYWORDS: Record<BlockCommandId, readonly string[]> = {
  text: ["text", "paragraph", "plain", "zhengwen", "zw", "wenben", "wb"],
  h1: ["h1", "heading", "heading1", "title", "title1", "biaoti", "biaoti1", "bt", "bt1", "yjbt"],
  h2: ["h2", "heading2", "title2", "biaoti2", "bt2", "erji", "ejbt"],
  h3: ["h3", "heading3", "title3", "biaoti3", "bt3", "sanji", "sjbt"],
  ul: ["ul", "list", "bullet", "unordered", "liebiao", "lb", "wuxu", "wxlb"],
  ol: ["ol", "list", "ordered", "number", "numbered", "liebiao", "lb", "youxu", "yxlb"],
  task: ["task", "todo", "checkbox", "check", "daiban", "db", "renwu", "rw"],
  quote: ["quote", "blockquote", "cite", "yinyong", "yy"],
  code: ["code", "codeblock", "pre", "daima", "dm", "dmk"],
  table: ["table", "grid", "biaoge", "bg", "biaodan"],
  hr: ["hr", "divider", "separator", "rule", "line", "fenge", "fgx", "fg"],
  math: ["math", "formula", "latex", "katex", "gongshi", "gs"],
};

export function buildBlockCommands(translate: TFunction): BlockCommand[] {
  const labels: Record<BlockCommandId, string> = {
    text: translate("main.slash.commands.text", { defaultValue: "正文" }),
    h1: translate("main.slash.commands.h1", { defaultValue: "标题 1" }),
    h2: translate("main.slash.commands.h2", { defaultValue: "标题 2" }),
    h3: translate("main.slash.commands.h3", { defaultValue: "标题 3" }),
    ul: translate("main.slash.commands.ul", { defaultValue: "无序列表" }),
    ol: translate("main.slash.commands.ol", { defaultValue: "有序列表" }),
    task: translate("main.slash.commands.task", { defaultValue: "待办事项" }),
    quote: translate("main.slash.commands.quote", { defaultValue: "引用" }),
    code: translate("main.slash.commands.code", { defaultValue: "代码块" }),
    table: translate("main.slash.commands.table", { defaultValue: "表格" }),
    hr: translate("main.slash.commands.hr", { defaultValue: "分割线" }),
    math: translate("main.slash.commands.math", { defaultValue: "公式块" }),
  };

  return ORDER.map((id) => ({
    id,
    label: labels[id],
    syntax: SYNTAX[id],
    keywords: KEYWORDS[id],
  }));
}

/**
 * 按输入过滤命令。标签与别名都参与匹配：中文用户可以直接输入「表格」，
 * 英文/拼音用户输入 `table`、`bg` 也能命中。
 * 排序规则：完全匹配 > 前缀匹配 > 标签包含 > 别名包含，同分保持原顺序。
 */
export function matchBlockCommands(
  commands: readonly BlockCommand[],
  query: string,
): BlockCommand[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...commands];

  const scored: Array<{ command: BlockCommand; score: number; order: number }> = [];

  commands.forEach((command, order) => {
    const label = command.label.toLowerCase();
    let score = Number.POSITIVE_INFINITY;

    if (label === normalized) score = 0;
    else if (label.startsWith(normalized)) score = 1;
    else if (label.includes(normalized)) score = 2;

    for (const keyword of command.keywords) {
      const value = keyword.toLowerCase();
      if (value === normalized) score = Math.min(score, 0);
      else if (value.startsWith(normalized)) score = Math.min(score, 1);
      else if (value.includes(normalized)) score = Math.min(score, 3);
    }

    if (Number.isFinite(score)) scored.push({ command, score, order });
  });

  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  return scored.map((entry) => entry.command);
}

/**
 * 行首块标记：标题、引用、列表（含任务框），可连续出现（如 `> - `）。
 * 标记后必须跟空白，`---`、`#标签` 这类写法不会被误判。
 */
const MARKER_RE = /^[ \t]*((?:#{1,6}|>|[-*+]|\d+[.)])(?:[ \t]+\[[ xX]\])?[ \t]+)/;

interface BlockPrefix {
  /** 行首缩进（标记之前的空白） */
  indent: string;
  /** 缩进 + 全部块标记；没有标记时为空串 */
  prefix: string;
  /** 最后一个标记的起点（相对整行）；没有标记时为 -1 */
  lastMarkerStart: number;
  /** 正文起点（相对整行） */
  bodyStart: number;
}

function splitBlockPrefix(lineText: string): BlockPrefix {
  const indent = /^[ \t]*/.exec(lineText)?.[0] ?? "";
  let end = 0;
  let lastMarkerStart = -1;

  for (;;) {
    const match = MARKER_RE.exec(lineText.slice(end));
    if (!match) break;
    // match[1] 不含前导空白，用它反推出标记本体的起点
    lastMarkerStart = end + match[0].length - match[1].length;
    end += match[0].length;
  }

  const prefix = lineText.slice(0, end);
  // 没有标记时，正文要跳过行首缩进
  const bodyStart = end + (/^[ \t]*/.exec(lineText.slice(end))?.[0].length ?? 0);

  return { indent, prefix, lastMarkerStart, bodyStart };
}

/**
 * `/` 允许出现的行内位置：行首缩进与块标记之后。
 * 返回该位置相对整行的偏移。
 */
export function blockPrefixEnd(lineText: string): number {
  return splitBlockPrefix(lineText).bodyStart;
}

export interface SlashToken {
  /** `/` 的位置（含） */
  from: number;
  /** 光标位置（不含） */
  to: number;
  /** `/` 之后到光标之间的查询文字 */
  query: string;
}

/**
 * 光标前的 `/查询`，供 textarea 与 CodeMirror 共用。
 * 只做文本判定，不涉及语法树；代码块内的过滤由调用方补充。
 */
export function findSlashTokenInText(text: string, pos: number): SlashToken | null {
  const lineFrom = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const lineEnd = text.indexOf("\n", pos);
  const lineText = text.slice(lineFrom, lineEnd < 0 ? text.length : lineEnd);

  const from = lineFrom + blockPrefixEnd(lineText);
  if (pos <= from) return null;

  // 中文输入法下的全角斜杠同样视为命令入口
  const marker = text.slice(from, from + 1);
  if (marker !== "/" && marker !== "／") return null;

  return { from, to: pos, query: text.slice(from + 1, pos) };
}

function lineBoundsAt(doc: string, pos: number): { from: number; to: number } {
  const from = doc.lastIndexOf("\n", pos - 1) + 1;
  let to = doc.indexOf("\n", pos);
  if (to < 0) to = doc.length;
  return { from, to };
}

/**
 * 不带 `/查询` 的整行转换：把光标所在行直接变成目标块。
 *
 * textarea 与工具栏按钮没有行内补全，用这个入口复用同一套命令语义。
 * 多行选区只处理光标所在行——标题、引用这类块本来就以行为单位。
 */
export function applyBlockCommandToLine(
  doc: string,
  pos: number,
  id: BlockCommandId,
  translate: TFunction,
): BlockCommandResult | null {
  const line = lineBoundsAt(doc, Math.max(0, Math.min(pos, doc.length)));
  const anchorInLine = blockPrefixEnd(doc.slice(line.from, line.to));
  const tokenPos = line.from + anchorInLine;
  return applyBlockCommand(doc, tokenPos, tokenPos, id, translate);
}

/**
 * 把 `/查询` 所在行转换成目标块。
 *
 * 整行一次性替换，撤销时是一步；`/查询` 之外的文字全部保留。
 * 返回 null 表示区间跨行或越界，调用方应放弃这次转换。
 */
export function applyBlockCommand(
  doc: string,
  tokenFrom: number,
  tokenTo: number,
  id: BlockCommandId,
  translate: TFunction,
  options: { tableSize?: TableSize } = {},
): BlockCommandResult | null {
  const line = lineBoundsAt(doc, tokenFrom);
  if (tokenTo < tokenFrom || tokenTo > line.to) return null;

  const rawLine = doc.slice(line.from, line.to);
  // `/查询` 之前的部分恰好是缩进 + 块标记；之后的部分才是正文。
  // 只切这两段，避免把命令后的分隔空格误当成缩进。
  const prefixPart = rawLine.slice(0, tokenFrom - line.from);
  const body = rawLine.slice(tokenTo - line.from).replace(/^[ \t]+/, "");
  const { indent, prefix, lastMarkerStart } = splitBlockPrefix(prefixPart);
  const hasLineBreak = line.to < doc.length;

  const replaceLine = (insert: string, anchor: number, head = anchor): BlockCommandResult => ({
    change: { from: line.from, to: line.to, insert },
    anchor,
    head,
  });

  /** 多行块会展开，吃掉原行的换行，避免留下空行 */
  const replaceWholeLine = (insert: string, anchor: number, head = anchor): BlockCommandResult => ({
    change: { from: line.from, to: line.to + (hasLineBreak ? 1 : 0), insert },
    anchor,
    head,
  });

  const marker = MARKERS[id];
  if (marker !== undefined) {
    // 同一行只保留一种块类型：替换最后一个标记，保留外层嵌套（`> - ` → `> # `）
    const base = lastMarkerStart >= 0 ? prefix.slice(0, lastMarkerStart) : indent;
    const insert = base + marker + body;
    return replaceLine(insert, line.from + insert.length);
  }

  if (id === "text") {
    const insert = indent + body;
    return replaceLine(insert, line.from + insert.length);
  }

  if (id === "hr") {
    if (body) {
      // 有正文时不吞内容：正文留在上面，分割线补在下面
      const insert = `${indent}${body}\n\n${indent}---`;
      return replaceLine(insert, line.from + indent.length + body.length);
    }
    // 紧跟在正文后面的 `---` 会把上一行变成 Setext 标题，需要先补一个空行
    const before = line.from > 0 ? lineBoundsAt(doc, line.from - 1) : null;
    const hasTextBefore = before ? doc.slice(before.from, before.to).trim().length > 0 : false;
    const insert = `${hasTextBefore ? "\n" : ""}${indent}---`;
    return replaceLine(insert, line.from + insert.length);
  }

  if (id === "code") {
    const bodyLine = body ? indent + body : "";
    const insert = `${indent}\`\`\`\n${bodyLine}\n${indent}\`\`\`\n`;
    const anchor = line.from + indent.length + 4 + bodyLine.length;
    return replaceWholeLine(insert, anchor);
  }

  if (id === "table") {
    const size = options.tableSize ?? { columns: 2, rows: 2 };
    const { text: table, headerStart, headerLength } = buildTableBlock(size, indent, translate);
    const head = body ? `${indent}${body}\n\n` : "";
    // 选中第一个表头占位符，直接输入即可覆盖
    const anchor = line.from + head.length + headerStart;
    return replaceWholeLine(head + table, anchor, anchor + headerLength);
  }
  if (id === "math") {
    const formula = body || "x^2 + y^2 = r^2";
    const insert = `${indent}$$\n${indent}${formula}\n${indent}$$\n`;
    const anchor = line.from + indent.length + 3;
    return replaceWholeLine(insert, anchor, anchor + formula.length);
  }

  return null;
}
