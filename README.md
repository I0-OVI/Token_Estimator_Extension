# Token Prediction（VS Code 扩展）

在本地用 **tiktoken**（与常见计费编码对齐）和 **启发式规则**，对「当前任务可能消耗多少 token」做**粗略估计**，辅助你在写提示词或扫仓库时心里有个数。

---

## 重要声明（请务必阅读）

**本扩展无法、也不承诺与任何平台账单上的 token 用量完全一致。**  
真实计费取决于：服务商实际使用的模型与分词器、请求里不可见的系统提示/工具调用/多轮上下文、是否流式、是否缓存命中、以及各厂商自己的计量方式等。扩展只能在**你可见的文本**上做本地估算，输出侧更是**启发式区间**，不是预言。

把它当作**参考范围**，不要当作对账或维权依据。若与账单有偏差，属于预期之内。

---

## 能做什么

- **估算 token**：对当前编辑器中的全文或选区、或剪贴板内容，给出输入侧 tiktoken 计数，以及输出侧的**启发式**区间与合计。
- **状态栏（可选）**：根据当前活动编辑器内容做粗略展示（Composer 输入框对扩展不可见，需把草稿放在文件里或复制到编辑器再估）。
- **交互日志（JSONL）**：可记录编辑/交互，用于本地分析（路径可在设置里改）。
- **扫描工作区**：生成工作区结构摘要；可选构建导入图并对节点源码做 tiktoken 统计，用于上下文相关的额外预算（仍属启发式）。
- **LLM 作用域（可选）**：配置 OpenAI 兼容接口后，用一次 LLM 调用估算「额外上下文」量级，结果可缓存到本地 JSON，参与总估算（需自行在命令里设置 API Key，密钥走 VS Code Secret Storage）。

---

## 如何使用

### 安装

- **从源码开发**：克隆仓库后执行 `npm install`、`npm run compile`，在 VS Code 中选择 **Run Extension** 调试；或 `npm run package:vsix` 生成 `.vsix` 后通过 **Extensions: Install from VSIX…** 安装。

### 命令面板（`Cmd+Shift+P` / `Ctrl+Shift+P`）

| 命令 | 说明 |
|------|------|
| **Token Prediction: Estimate tokens…** | 选择「当前文件或选区」或「剪贴板」，弹出估算结果（含输入、输出区间、合计区间）。 |
| **Token Prediction: Interaction log…** | 开始记录编辑，或打开交互日志面板写入 JSONL。 |
| **Token Prediction: Scan workspace…** | 仅扫描工作区结构，或扫描并构建导入图（及可选 token 预算 JSON）。 |
| **Token Prediction: LLM…** | 设置 API Key、运行 LLM 作用域等与 LLM 相关的流程。 |

### 常用设置（`Settings` 里搜 `tokenPrediction`）

- **`tokenPrediction.tokenizer`**：`cl100k_base` 或 `o200k_base`，尽量贴近你实际计费模型。
- **`tokenPrediction.taskKind`**：任务类型（general / code / refactor 等），影响输出侧启发式倍数。
- **`tokenPrediction.includeHistoryTurns`**：假设额外多轮对话时的粗略加数。
- **`tokenPrediction.showStatusBar`**：是否显示状态栏预估。

更完整的选项说明见 `package.json` 中 `contributes.configuration`。

---

## 开发与脚本

```bash
npm install
npm run compile    # 编译 TypeScript
npm test           # 编译 + 冒烟测试
npm run package:vsix   # 打 VSIX（需已安装/可用的 @vscode/vsce）
```

仓库内 `scripts/`、`tools/` 下还有离线分析、特征表、校验 JSONL 等脚本，供研究与本地数据处理使用。

---

## 许可证

MIT License
