import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("h card store generates high-entropy cards and enforces one-time lifecycle", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-h-card-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const { JsonStore } = await import("../src/store.js");
  const store = new JsonStore(path.join(tempDir, "orders.json"));
  const cards = store.createHCards({ count: 2, productId: 3 });

  assert.equal(cards.length, 2);
  assert.notEqual(cards[0].code, cards[1].code);
  assert.equal(store.listHCards().every(card => !("code" in card) && !("codeHash" in card)), true);
  assert.equal(store.verifyHCard(cards[0].code).ok, true);

  const reservation = store.reserveHCard(cards[0].code, "order-1");
  assert.equal(reservation.ok, true);
  assert.equal(store.verifyHCard(cards[0].code).status, "reserved");
  assert.equal(store.completeHCard(reservation.cardId, "wrong-order"), false);
  assert.equal(store.releaseHCard(reservation.cardId, "order-1"), true);
  assert.equal(store.verifyHCard(cards[0].code).ok, true);

  const secondReservation = store.reserveHCard(cards[0].code, "order-2");
  assert.equal(store.completeHCard(secondReservation.cardId, "order-2"), true);
  assert.equal(store.verifyHCard(cards[0].code).status, "used");
  assert.equal(store.reserveHCard(cards[0].code, "order-3").status, "used");
});
