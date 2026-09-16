import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  cardinalityChoiceFromPair,
  cardinalityPairFromChoice,
  edgeCardinalityPair,
  type CardinalityChoice,
} from "../../apps/desktop/src/lib/diagram/cardinality.ts";

const CHOICES: CardinalityChoice[] = ["one-to-one", "one-to-many", "many-to-one", "many-to-many"];

test("cardinalityPairFromChoice maps all four choices", () => {
  assert.deepEqual(cardinalityPairFromChoice("one-to-one"), { sourceCardinality: "1", targetCardinality: "1" });
  assert.deepEqual(cardinalityPairFromChoice("one-to-many"), { sourceCardinality: "1", targetCardinality: "N" });
  assert.deepEqual(cardinalityPairFromChoice("many-to-one"), { sourceCardinality: "N", targetCardinality: "1" });
  assert.deepEqual(cardinalityPairFromChoice("many-to-many"), { sourceCardinality: "N", targetCardinality: "N" });
});

test("cardinalityChoiceFromPair maps all four pairs and falls back to many-to-one", () => {
  assert.equal(cardinalityChoiceFromPair({ sourceCardinality: "1", targetCardinality: "1" }), "one-to-one");
  assert.equal(cardinalityChoiceFromPair({ sourceCardinality: "1", targetCardinality: "N" }), "one-to-many");
  assert.equal(cardinalityChoiceFromPair({ sourceCardinality: "N", targetCardinality: "1" }), "many-to-one");
  assert.equal(cardinalityChoiceFromPair({ sourceCardinality: "N", targetCardinality: "N" }), "many-to-many");
  assert.equal(cardinalityChoiceFromPair(undefined), "many-to-one");
  assert.equal(cardinalityChoiceFromPair(null), "many-to-one");
  assert.equal(cardinalityChoiceFromPair({}), "many-to-one");
  assert.equal(cardinalityChoiceFromPair({ sourceCardinality: "1" }), "many-to-one");
});

test("edgeCardinalityPair returns explicit pair or defaults to N:1", () => {
  assert.deepEqual(edgeCardinalityPair({ sourceCardinality: "1", targetCardinality: "N" }), {
    sourceCardinality: "1",
    targetCardinality: "N",
  });
  assert.deepEqual(edgeCardinalityPair({}), { sourceCardinality: "N", targetCardinality: "1" });
  assert.deepEqual(edgeCardinalityPair(undefined), { sourceCardinality: "N", targetCardinality: "1" });
  assert.deepEqual(edgeCardinalityPair(null), { sourceCardinality: "N", targetCardinality: "1" });
});

test("choice → pair → choice round-trips for all choices", () => {
  for (const choice of CHOICES) {
    assert.equal(cardinalityChoiceFromPair(cardinalityPairFromChoice(choice)), choice);
  }
});
