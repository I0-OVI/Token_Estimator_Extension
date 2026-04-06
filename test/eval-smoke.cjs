const assert = require("assert");
const {
  meanAbsoluteError,
  meanAbsolutePercentageError,
  underEstimationRate,
  compareToBaseline,
  bucketByActualTokens,
} = require("../out/eval.js");

const examples = [
  { predictedTotal: 100, actualTotal: 110 },
  { predictedTotal: 200, actualTotal: 180 },
];
assert.strictEqual(meanAbsoluteError(examples), 15);
assert.ok(meanAbsolutePercentageError(examples) > 0);
assert.strictEqual(underEstimationRate([{ predictedTotal: 50, actualTotal: 100 }]), 1);
assert.strictEqual(bucketByActualTokens(50, [100, 500]), "short");
const cmp = compareToBaseline(examples, () => 150);
assert.ok(typeof cmp.modelMae === "number");
assert.ok(typeof cmp.baselineMae === "number");
console.log("eval smoke ok");
