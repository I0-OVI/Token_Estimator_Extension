#!/usr/bin/env python3
"""
Desktop scratchpad to append training samples to the same JSONL format as the
Token Prediction VS Code extension (schemaVersion 1).

Requires only the Python standard library (tkinter). On macOS you need **Tcl/Tk 8.6+**
(system /usr/bin/python3 often ships Tk 8.5.x → blank window). Use Homebrew `python-tk`
or the python.org installer; then run with that interpreter.

Usage:
  python tools/token_sample_logger.py
  TOKEN_PREDICTION_LOG=/path/to/token_prediction_log.jsonl python tools/token_sample_logger.py
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

# 须在 import tkinter 之前：系统 Tk 弃用提示；对 Aqua 渲染也有帮助
if platform.system() == "Darwin":
    os.environ.setdefault("TK_SILENCE_DEPRECATION", "1")

import tkinter as tk
import tkinter.font as tkfont
from tkinter import filedialog, messagebox, ttk


def _tcl_patchlevel_tuple() -> tuple[int, int, int]:
    raw = tk.Tcl().eval("info patchlevel")
    segs: list[int] = []
    for part in raw.split("."):
        num = ""
        for ch in part:
            if ch.isdigit():
                num += ch
            else:
                break
        segs.append(int(num) if num else 0)
    while len(segs) < 3:
        segs.append(0)
    return segs[0], segs[1], segs[2]


def _tk_is_supported() -> bool:
    """Tcl/Tk 8.5 on modern macOS is known to render a blank / gray window."""
    a, b, _ = _tcl_patchlevel_tuple()
    if a > 8:
        return True
    if a == 8 and b >= 6:
        return True
    return False


SCHEMA_VERSION = 1


@dataclass(frozen=True)
class UiColors:
    bg_main: str
    bg_panel: str
    fg_text: str
    fg_muted: str
    bg_help: str
    sel_bg: str
    sel_fg: str
    insert: str


def _macos_dark_appearance() -> bool:
    """系统为深色时，Tk 在 macOS 上常与「浅色硬编码」冲突，导致整块像空白且难以输入。"""
    if platform.system() != "Darwin":
        return False
    try:
        r = subprocess.run(
            ["defaults", "read", "-g", "AppleInterfaceStyle"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        return r.returncode == 0 and "Dark" in (r.stdout or "")
    except (OSError, subprocess.TimeoutExpired):
        return False


def theme_colors() -> UiColors:
    if _macos_dark_appearance():
        return UiColors(
            bg_main="#2d2d2d",
            bg_panel="#1e1e1e",
            fg_text="#ececec",
            fg_muted="#a8a8a8",
            bg_help="#3d3520",
            sel_bg="#264f78",
            sel_fg="#ffffff",
            insert="#ffffff",
        )
    return UiColors(
        bg_main="#ececec",
        bg_panel="#ffffff",
        fg_text="#1a1a1a",
        fg_muted="#555555",
        bg_help="#fff9e6",
        sel_bg="#b4d5ff",
        sel_fg="#1a1a1a",
        insert="#1a1a1a",
    )


def _ui_font(size: int = 13) -> tuple[str, int]:
    if platform.system() == "Darwin":
        return ("PingFang SC", size)
    return ("Microsoft YaHei UI", size)


def _apply_theme(root: tk.Tk, c: UiColors) -> None:
    root.configure(bg=c.bg_main)
    try:
        style = ttk.Style(root)
        if platform.system() == "Darwin":
            style.theme_use("clam")
        style.configure(".", background=c.bg_main, foreground=c.fg_text)
        style.configure("TFrame", background=c.bg_main)
        style.configure("TLabel", background=c.bg_main, foreground=c.fg_text)
        style.configure("TLabelframe", background=c.bg_help, foreground=c.fg_text)
        style.configure("TLabelframe.Label", background=c.bg_help, foreground=c.fg_text)
        style.configure("TNotebook", background=c.bg_main, borderwidth=0)
        style.configure(
            "TNotebook.Tab",
            padding=[12, 6],
            background=c.bg_panel,
            foreground=c.fg_text,
        )
        style.map(
            "TNotebook.Tab",
            background=[("selected", c.bg_help), ("!selected", c.bg_panel)],
            foreground=[("selected", c.fg_text), ("!selected", c.fg_muted)],
        )
        style.configure("TButton", padding=6)
        style.configure(
            "TEntry",
            fieldbackground=c.bg_panel,
            foreground=c.fg_text,
            insertcolor=c.insert,
        )
        style.configure("Vertical.TScrollbar", background=c.bg_panel, troughcolor=c.bg_main)
        style.configure("Horizontal.TScrollbar", background=c.bg_panel, troughcolor=c.bg_main)
    except tk.TclError:
        pass


HELP_CN = (
    "【各字段写在哪里】对应 JSON 里的键名如下。\n"
    "• 标签「User prompt」→ userPrompt：本轮你在 Cursor 里输入的问题/指令（可复制 Chat 里用户气泡）。\n"
    "• 标签「Assistant」→ assistantMarkdown：助手完整回复，支持 Markdown（可复制助手气泡）。\n"
    "• 标签「Thought」→ thoughtMarkdown：模型思考/推理全文（若界面有单独区块可复制；与 prompt/answer 同级）。\n"
    "• 标签「数值与文件」→ cursorReportedTokens：Cursor 用量/账单里显示的本轮 token（没有就留空）。\n"
    "  → linesAdded / linesRemoved：本轮改代码大致「增加行数 / 删除行数」（可看 git diff 或自己估）。\n"
    "  → linesTotalAbs 保存时会自动 = 加 + 减，不必手填。\n"
    "  → grepContextFileCount / readContextFileCount：本轮「grep/搜索」与「read_file」类涉及的大致文件数（整数即可）。\n"
    "  → filesRead（可选）：路径列表，一行一个；可不填——相对路径或文件名即可，不必写绝对路径。\n"
    "  → filesReadCount：保存时 = 上两项之和；若未填数字但填了路径，则用路径行数。\n"
    "  → filesChangedCount / filesTouched：实际改过的文件个数与路径列表。\n"
    "保存：追加一行到下方「日志文件」路径（与 VS Code 扩展写入格式相同）。"
)


def default_log_path() -> Path:
    env = os.environ.get("TOKEN_PREDICTION_LOG", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    cwd = Path.cwd()
    return cwd / ".cursor" / "token_prediction_log.jsonl"


def parse_int_entry(raw: str, default: int = 0) -> int:
    raw = raw.strip()
    if not raw:
        return default
    try:
        return int(raw.replace(",", ""))
    except ValueError:
        return default


def parse_optional_tokens(raw: str) -> int | None:
    raw = raw.strip()
    if not raw:
        return None
    # Support "6.7万" style loosely
    raw = raw.replace(",", "").replace(" ", "")
    if raw.endswith("万"):
        try:
            return int(float(raw[:-1]) * 10000)
        except ValueError:
            return None
    try:
        return int(raw)
    except ValueError:
        return None


def files_touched_from_text(block: str) -> list[str]:
    lines = []
    for line in block.splitlines():
        line = line.strip()
        if line:
            lines.append(line)
    return lines


def build_record(
    user_prompt: str,
    assistant_md: str,
    thought_md: str,
    cursor_tokens: int | None,
    lines_added: int,
    lines_removed: int,
    files_changed_count: int,
    files_touched: list[str],
    files_read: list[str],
    grep_context_file_count: int,
    read_context_file_count: int,
) -> dict:
    total_abs = lines_added + lines_removed
    files_read_count = grep_context_file_count + read_context_file_count
    if files_read_count == 0 and files_read:
        files_read_count = len(files_read)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "timestampIso": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "userPrompt": user_prompt,
        "assistantMarkdown": assistant_md,
        "thoughtMarkdown": thought_md,
        "cursorReportedTokens": cursor_tokens,
        "linesAdded": lines_added,
        "linesRemoved": lines_removed,
        "linesTotalAbs": total_abs,
        "filesChangedCount": files_changed_count,
        "filesTouched": files_touched,
        "grepContextFileCount": grep_context_file_count,
        "readContextFileCount": read_context_file_count,
        "filesRead": files_read,
        "filesReadCount": files_read_count,
    }


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Token 样本记录器（JSONL）")
        self.geometry("920x820")
        self.minsize(640, 520)
        self._c = theme_colors()
        _apply_theme(self, self._c)

        self._font = tkfont.Font(font=_ui_font(13))
        try:
            self._font_mono = tkfont.Font(family="Menlo", size=12)
        except tk.TclError:
            self._font_mono = self._font

        self.log_path_var = tk.StringVar(value=str(default_log_path()))
        c = self._c

        help_box = ttk.LabelFrame(self, text="字段说明（写在哪里）", padding=8)
        help_box.grid(row=0, column=0, sticky=tk.EW, padx=10, pady=(10, 4))
        tk.Label(
            help_box,
            text=HELP_CN,
            justify=tk.LEFT,
            wraplength=860,
            bg=c.bg_help,
            fg=c.fg_text,
            font=self._font,
        ).pack(anchor=tk.W)

        menubar = tk.Menu(self)
        file_menu = tk.Menu(menubar, tearoff=0)
        file_menu.add_command(label="Choose log file…", command=self.choose_log_file)
        file_menu.add_separator()
        file_menu.add_command(label="Quit", command=self.destroy)
        menubar.add_cascade(label="File", menu=file_menu)
        self.config(menu=menubar)

        top = ttk.Frame(self, padding=8)
        top.grid(row=1, column=0, sticky=tk.EW, padx=10, pady=2)
        ttk.Label(
            top,
            text="日志文件（每点一次「追加」就 append 一行 JSONL；字段 userPrompt 等都会写进这一行）:",
        ).pack(anchor=tk.W)
        path_row = ttk.Frame(top)
        path_row.pack(fill=tk.X, pady=(0, 6))
        self.path_entry = ttk.Entry(path_row, textvariable=self.log_path_var)
        self.path_entry.pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(path_row, text="Browse…", command=self.choose_log_file).pack(
            side=tk.LEFT, padx=(8, 0)
        )

        self._nb = ttk.Notebook(self)
        self._nb.grid(row=2, column=0, sticky=tk.NSEW, padx=10, pady=4)

        tab_user = ttk.Frame(self._nb, padding=6)
        tab_asst = ttk.Frame(self._nb, padding=6)
        tab_thought = ttk.Frame(self._nb, padding=6)
        tab_meta = ttk.Frame(self._nb, padding=6)
        self._nb.add(tab_user, text="① User prompt")
        self._nb.add(tab_asst, text="② Assistant 回复")
        self._nb.add(tab_thought, text="③ Thought / 思考")
        self._nb.add(tab_meta, text="④ 数值与文件")

        tab_user.columnconfigure(0, weight=1)
        tab_user.rowconfigure(1, weight=1)
        tk.Label(
            tab_user,
            text="→ JSON 字段【userPrompt】：粘贴本轮「用户侧」完整内容（可删减后再保存）。",
            bg=c.bg_main,
            fg=c.fg_muted,
            font=self._font,
        ).grid(row=0, column=0, sticky=tk.W, pady=(0, 4))
        u_wrap = ttk.Frame(tab_user)
        u_wrap.grid(row=1, column=0, sticky=tk.NSEW)
        u_wrap.columnconfigure(0, weight=1)
        u_wrap.rowconfigure(0, weight=1)
        self.txt_user = tk.Text(
            u_wrap,
            **self._text_opts(height=10, wrap=tk.WORD),
        )
        sy1 = ttk.Scrollbar(u_wrap, command=self.txt_user.yview)
        self.txt_user.configure(yscrollcommand=sy1.set)
        self.txt_user.grid(row=0, column=0, sticky=tk.NSEW)
        sy1.grid(row=0, column=1, sticky=tk.NS)

        tab_asst.columnconfigure(0, weight=1)
        tab_asst.rowconfigure(1, weight=1)
        tk.Label(
            tab_asst,
            text="→ JSON 字段【assistantMarkdown】：粘贴助手回复全文；需要可删改。",
            bg=c.bg_main,
            fg=c.fg_muted,
            font=self._font,
        ).grid(row=0, column=0, sticky=tk.W, pady=(0, 4))
        a_wrap = ttk.Frame(tab_asst)
        a_wrap.grid(row=1, column=0, sticky=tk.NSEW)
        a_wrap.columnconfigure(0, weight=1)
        a_wrap.rowconfigure(0, weight=1)
        self.txt_assistant = tk.Text(
            a_wrap,
            **self._text_opts(height=10, wrap=tk.WORD),
        )
        sy2 = ttk.Scrollbar(a_wrap, command=self.txt_assistant.yview)
        self.txt_assistant.configure(yscrollcommand=sy2.set)
        self.txt_assistant.grid(row=0, column=0, sticky=tk.NSEW)
        sy2.grid(row=0, column=1, sticky=tk.NS)

        tab_thought.columnconfigure(0, weight=1)
        tab_thought.rowconfigure(1, weight=1)
        tk.Label(
            tab_thought,
            text="→ JSON 字段【thoughtMarkdown】：粘贴模型思考/推理全文（与 user / assistant 同级；无则留空）。",
            bg=c.bg_main,
            fg=c.fg_muted,
            font=self._font,
        ).grid(row=0, column=0, sticky=tk.W, pady=(0, 4))
        t_wrap = ttk.Frame(tab_thought)
        t_wrap.grid(row=1, column=0, sticky=tk.NSEW)
        t_wrap.columnconfigure(0, weight=1)
        t_wrap.rowconfigure(0, weight=1)
        self.txt_thought = tk.Text(
            t_wrap,
            **self._text_opts(height=10, wrap=tk.WORD),
        )
        sy_t = ttk.Scrollbar(t_wrap, command=self.txt_thought.yview)
        self.txt_thought.configure(yscrollcommand=sy_t.set)
        self.txt_thought.grid(row=0, column=0, sticky=tk.NSEW)
        sy_t.grid(row=0, column=1, sticky=tk.NS)

        tab_meta.columnconfigure(0, weight=1)
        tab_meta.rowconfigure(1, weight=1)
        tk.Label(
            tab_meta,
            text="以下为训练用「特征」：用量、改行数、文件列表；与扩展插件里字段一致。",
            bg=c.bg_main,
            fg=c.fg_muted,
            font=self._font,
        ).grid(row=0, column=0, sticky=tk.W, pady=(0, 6))

        meta_outer = ttk.Frame(tab_meta)
        meta_outer.grid(row=1, column=0, sticky=tk.NSEW)
        meta_outer.columnconfigure(0, weight=1)
        meta_outer.rowconfigure(0, weight=1)

        meta_canvas = tk.Canvas(
            meta_outer,
            highlightthickness=0,
            bd=0,
            bg=c.bg_main,
        )
        meta_vsb = ttk.Scrollbar(meta_outer, orient=tk.VERTICAL, command=meta_canvas.yview)
        meta_canvas.configure(yscrollcommand=meta_vsb.set)

        meta_grid = ttk.Frame(meta_canvas)
        meta_inner_win = meta_canvas.create_window((0, 0), window=meta_grid, anchor=tk.NW)

        def _meta_canvas_on_configure(e: tk.Event) -> None:
            meta_canvas.itemconfigure(meta_inner_win, width=e.width)

        def _meta_inner_on_configure(_e: tk.Event | None = None) -> None:
            meta_canvas.configure(scrollregion=meta_canvas.bbox("all"))

        meta_canvas.bind("<Configure>", _meta_canvas_on_configure)
        meta_grid.bind("<Configure>", _meta_inner_on_configure)

        meta_canvas.grid(row=0, column=0, sticky=tk.NSEW)
        meta_vsb.grid(row=0, column=1, sticky=tk.NS)
        self._meta_canvas = meta_canvas

        meta_grid.columnconfigure(0, weight=0)
        meta_grid.columnconfigure(1, weight=0)
        meta_grid.columnconfigure(2, weight=1)

        r = 0
        ttk.Label(meta_grid, text="【cursorReportedTokens】Cursor 显示的本轮 token：").grid(
            row=r, column=0, sticky=tk.W, pady=4
        )
        self.var_tokens = tk.StringVar()
        ttk.Entry(meta_grid, textvariable=self.var_tokens, width=24).grid(
            row=r, column=1, sticky=tk.W, pady=4
        )
        ttk.Label(
            meta_grid,
            text="可选；整数或 6.7万；无则留空",
            foreground=c.fg_muted,
        ).grid(row=r, column=2, sticky=tk.W, padx=8)

        r += 1
        ttk.Label(meta_grid, text="【linesAdded】增加行数 (+)：").grid(
            row=r, column=0, sticky=tk.W, pady=4
        )
        self.var_plus = tk.StringVar(value="0")
        ttk.Entry(meta_grid, textvariable=self.var_plus, width=12).grid(
            row=r, column=1, sticky=tk.W, pady=4
        )
        ttk.Label(meta_grid, text="无改动填 0", foreground=c.fg_muted).grid(
            row=r, column=2, sticky=tk.W, padx=8
        )

        r += 1
        ttk.Label(meta_grid, text="【linesRemoved】删除行数 (−)：").grid(
            row=r, column=0, sticky=tk.W, pady=4
        )
        self.var_minus = tk.StringVar(value="0")
        ttk.Entry(meta_grid, textvariable=self.var_minus, width=12).grid(
            row=r, column=1, sticky=tk.W, pady=4
        )
        ttk.Label(meta_grid, text="保存时自动算 linesTotalAbs = + + −", foreground=c.fg_muted).grid(
            row=r, column=2, sticky=tk.W, padx=8
        )

        r += 1
        ttk.Label(meta_grid, text="【filesChangedCount】涉及文件个数：").grid(
            row=r, column=0, sticky=tk.W, pady=4
        )
        self.var_file_count = tk.StringVar(value="0")
        ttk.Entry(meta_grid, textvariable=self.var_file_count, width=12).grid(
            row=r, column=1, sticky=tk.W, pady=4
        )
        ttk.Label(meta_grid, text="若下面已填路径且此处为 0，会用路径行数代替", foreground=c.fg_muted).grid(
            row=r, column=2, sticky=tk.W, padx=8
        )

        r += 1
        ttk.Label(meta_grid, text="【grepContextFileCount】grep/搜索 涉及文件数：").grid(
            row=r, column=0, sticky=tk.W, pady=4
        )
        self.var_grep_files = tk.StringVar(value="0")
        self.entry_grep = ttk.Entry(meta_grid, textvariable=self.var_grep_files, width=12)
        self.entry_grep.grid(row=r, column=1, sticky=tk.W, pady=4)
        ttk.Label(meta_grid, text="整数即可", foreground=c.fg_muted).grid(
            row=r, column=2, sticky=tk.W, padx=8
        )

        r += 1
        ttk.Label(meta_grid, text="【readContextFileCount】read_file 类 文件数：").grid(
            row=r, column=0, sticky=tk.W, pady=4
        )
        self.var_read_files = tk.StringVar(value="0")
        self.entry_read = ttk.Entry(meta_grid, textvariable=self.var_read_files, width=12)
        self.entry_read.grid(row=r, column=1, sticky=tk.W, pady=4)
        ttk.Label(meta_grid, text="与上一项相加 → filesReadCount", foreground=c.fg_muted).grid(
            row=r, column=2, sticky=tk.W, padx=8
        )

        r += 1
        ttk.Label(
            meta_grid,
            text="【filesRead】可选：路径一行一个（相对路径/文件名即可，不必绝对路径）：",
        ).grid(row=r, column=0, columnspan=3, sticky=tk.W, pady=(12, 4))
        r += 1
        read_frame = ttk.Frame(meta_grid)
        read_frame.grid(row=r, column=0, columnspan=3, sticky=tk.NSEW)
        meta_grid.rowconfigure(r, weight=1)
        read_frame.columnconfigure(0, weight=1)
        read_frame.rowconfigure(0, weight=1)
        self.txt_files_read = tk.Text(
            read_frame,
            **self._text_opts(
                height=4,
                wrap=tk.NONE,
                font=self._font_mono,
                padx=4,
                pady=4,
            ),
        )
        sry = ttk.Scrollbar(read_frame, command=self.txt_files_read.yview)
        srx = ttk.Scrollbar(read_frame, orient=tk.HORIZONTAL, command=self.txt_files_read.xview)
        self.txt_files_read.configure(yscrollcommand=sry.set, xscrollcommand=srx.set)
        self.txt_files_read.grid(row=0, column=0, sticky=tk.NSEW)
        sry.grid(row=0, column=1, sticky=tk.NS)
        srx.grid(row=1, column=0, sticky=tk.EW)

        r += 1
        ttk.Label(
            meta_grid,
            text="【filesTouched】实际改写过的文件路径（一行一个，相对/绝对均可）：",
        ).grid(row=r, column=0, columnspan=3, sticky=tk.W, pady=(12, 4))
        r += 1
        files_frame = ttk.Frame(meta_grid)
        files_frame.grid(row=r, column=0, columnspan=3, sticky=tk.NSEW)
        meta_grid.rowconfigure(r, weight=1)

        files_frame.columnconfigure(0, weight=1)
        files_frame.rowconfigure(0, weight=1)
        self.txt_files = tk.Text(
            files_frame,
            **self._text_opts(
                height=6,
                wrap=tk.NONE,
                font=self._font_mono,
                padx=4,
                pady=4,
            ),
        )
        sfy = ttk.Scrollbar(files_frame, command=self.txt_files.yview)
        sfx = ttk.Scrollbar(files_frame, orient=tk.HORIZONTAL, command=self.txt_files.xview)
        self.txt_files.configure(yscrollcommand=sfy.set, xscrollcommand=sfx.set)
        self.txt_files.grid(row=0, column=0, sticky=tk.NSEW)
        sfy.grid(row=0, column=1, sticky=tk.NS)
        sfx.grid(row=1, column=0, sticky=tk.EW)

        bottom = ttk.Frame(self, padding=8)
        bottom.grid(row=3, column=0, sticky=tk.EW, padx=10, pady=(0, 10))
        ttk.Button(bottom, text="追加一条样本到 JSONL", command=self.append_sample).pack(
            side=tk.LEFT
        )
        ttk.Button(bottom, text="清空全部", command=self.clear_all).pack(
            side=tk.LEFT, padx=(12, 0)
        )
        ttk.Label(
            bottom,
            text="（+）+（−）的总活动行数在保存时自动写入 linesTotalAbs",
            foreground=c.fg_muted,
        ).pack(side=tk.RIGHT)

        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(2, weight=1)

        self._wire_text_focus()
        self.after(80, lambda: self.txt_user.focus_set())

    def _on_meta_mousewheel(self, event: tk.Event) -> None:
        if self._nb.index("current") != 3:
            return
        try:
            w = self.winfo_containing(event.x_root, event.y_root)
        except tk.TclError:
            return
        if isinstance(w, tk.Text):
            lo, hi = w.yview()
            d = getattr(event, "delta", 0) or 0
            if d:
                upward = d > 0
            elif getattr(event, "num", None) == 4:
                upward = True
            elif getattr(event, "num", None) == 5:
                upward = False
            else:
                upward = False
            if upward and lo > 0.001:
                return
            if not upward and hi < 0.999:
                return
        canvas = self._meta_canvas
        d = getattr(event, "delta", 0) or 0
        if d:
            if abs(d) < 10:
                units = -1 if d > 0 else 1
            else:
                units = int(-1 * d / 120)
            canvas.yview_scroll(units, "units")
        elif getattr(event, "num", None) == 4:
            canvas.yview_scroll(-1, "units")
        elif getattr(event, "num", None) == 5:
            canvas.yview_scroll(1, "units")

    def _text_opts(self, **kw: object) -> dict[str, object]:
        c = self._c
        base: dict[str, object] = {
            "bg": c.bg_panel,
            "fg": c.fg_text,
            "insertbackground": c.insert,
            "selectbackground": c.sel_bg,
            "selectforeground": c.sel_fg,
            "font": self._font,
            "relief": tk.FLAT,
            "padx": 6,
            "pady": 6,
            "borderwidth": 1,
            "highlightthickness": 1,
            "highlightbackground": c.bg_main,
            "highlightcolor": c.fg_muted,
            "insertwidth": 3,
            "cursor": "xterm",
            "takefocus": tk.TRUE,
        }
        base.update(kw)
        return base

    def _wire_text_focus(self) -> None:
        def focus_me(e: tk.Event) -> None:
            w = e.widget
            if isinstance(w, tk.Text):
                w.focus_set()

        for w in (self.txt_user, self.txt_assistant, self.txt_thought, self.txt_files_read, self.txt_files):
            w.bind("<Button-1>", focus_me, add=True)
            w.bind("<FocusIn>", lambda e: e.widget.configure(highlightcolor=self._c.fg_text), add=True)
            w.bind("<FocusOut>", lambda e: e.widget.configure(highlightcolor=self._c.fg_muted), add=True)

        def on_tab(_e: tk.Event) -> None:
            self.unbind_all("<MouseWheel>")
            i = self._nb.index("current")
            if i == 0:
                self.txt_user.focus_set()
            elif i == 1:
                self.txt_assistant.focus_set()
            elif i == 2:
                self.txt_thought.focus_set()
            else:
                self.entry_grep.focus_set()
                self.bind_all("<MouseWheel>", self._on_meta_mousewheel)

        self._nb.bind("<<NotebookTabChanged>>", on_tab, add=True)

    def choose_log_file(self) -> None:
        p = filedialog.asksaveasfilename(
            title="Log file (JSONL)",
            defaultextension=".jsonl",
            filetypes=[("JSON Lines", "*.jsonl"), ("All", "*")],
            initialfile="token_prediction_log.jsonl",
        )
        if p:
            self.log_path_var.set(p)

    def append_sample(self) -> None:
        user = self.txt_user.get("1.0", tk.END).rstrip("\n")
        asst = self.txt_assistant.get("1.0", tk.END).rstrip("\n")
        thought = self.txt_thought.get("1.0", tk.END).rstrip("\n")
        tokens = parse_optional_tokens(self.var_tokens.get())
        la = parse_int_entry(self.var_plus.get(), 0)
        lr = parse_int_entry(self.var_minus.get(), 0)
        fc = parse_int_entry(self.var_file_count.get(), 0)
        touched = files_touched_from_text(self.txt_files.get("1.0", tk.END))
        read_paths = files_touched_from_text(self.txt_files_read.get("1.0", tk.END))
        grep_c = parse_int_entry(self.var_grep_files.get(), 0)
        read_c = parse_int_entry(self.var_read_files.get(), 0)

        if fc == 0 and touched:
            fc = len(touched)

        rec = build_record(
            user,
            asst,
            thought,
            tokens,
            la,
            lr,
            fc,
            touched,
            read_paths,
            grep_c,
            read_c,
        )
        path = Path(self.log_path_var.get().strip())
        if not path.parent.exists():
            path.parent.mkdir(parents=True, exist_ok=True)

        line = json.dumps(rec, ensure_ascii=False) + "\n"
        try:
            with path.open("a", encoding="utf-8") as f:
                f.write(line)
        except OSError as e:
            messagebox.showerror("写入失败", str(e))
            return

        messagebox.showinfo("已保存", f"已追加一行到：\n{path}")

    def clear_all(self) -> None:
        self.txt_user.delete("1.0", tk.END)
        self.txt_assistant.delete("1.0", tk.END)
        self.txt_thought.delete("1.0", tk.END)
        self.txt_files.delete("1.0", tk.END)
        self.txt_files_read.delete("1.0", tk.END)
        self.var_tokens.set("")
        self.var_plus.set("0")
        self.var_minus.set("0")
        self.var_file_count.set("0")
        self.var_grep_files.set("0")
        self.var_read_files.set("0")


def main() -> None:
    if not _tk_is_supported():
        pl = tk.Tcl().eval("info patchlevel")
        print(
            f"当前解释器使用的 Tcl/Tk 版本为 {pl}，过旧；在 macOS 上常见症状是窗口全灰/空白、无法输入。\n"
            "请换用自带 Tcl/Tk 8.6+ 的 Python，例如：\n"
            "  brew install python-tk && brew install python@3.12\n"
            "  $(brew --prefix python@3.12)/bin/python3 tools/token_sample_logger.py\n"
            "（Apple Silicon 上 Homebrew 一般为 /opt/homebrew。）\n"
            "或安装 https://www.python.org/downloads/ 官方 macOS 包，再用其中的 python3。\n",
            file=sys.stderr,
        )
        sys.exit(1)
    try:
        app = App()
    except tk.TclError as e:
        print("tkinter not available:", e, file=sys.stderr)
        print("On macOS: install Python with Tk, e.g. `brew install python-tk`", file=sys.stderr)
        sys.exit(1)
    app.mainloop()


if __name__ == "__main__":
    main()
