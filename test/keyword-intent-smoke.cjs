const assert = require("assert");
const {
  inferTaskKindFromText,
  pickTaskKindFromScores,
  parseKeywordTaskKindMode,
  runEstimateWithKeywords,
} = require("../out/keywordIntent.js");
const { DEFAULT_PREDICTION_OPTIONS } = require("../out/config.js");

assert.strictEqual(parseKeywordTaskKindMode(undefined), "off");
assert.strictEqual(parseKeywordTaskKindMode("override"), "override");

const q = inferTaskKindFromText("为什么会出现这个错误？");
assert.ok(["explain", "general"].includes(q.kind) || q.scores.explain > 0);

const r = inferTaskKindFromText("refactor this module and rename the class");
assert.strictEqual(r.kind, "refactor");

const plain = inferTaskKindFromText("abc");
assert.strictEqual(pickTaskKindFromScores(plain.scores, "code"), "code");

const { est, extraNotes } = runEstimateWithKeywords("hello", DEFAULT_PREDICTION_OPTIONS, "hint_only");
assert.ok(est.totalTokensExpected > 0);
assert.ok(extraNotes.length >= 1);

const { est: est2 } = runEstimateWithKeywords("refactor all", DEFAULT_PREDICTION_OPTIONS, "override");
assert.ok(est2.outputTokensExpected > 0);

console.log("keyword-intent smoke ok");
