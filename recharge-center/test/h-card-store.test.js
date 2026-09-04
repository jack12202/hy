import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("h cards bind once, stay locked on failure, and support admin unlock/disable", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-h-card-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const { JsonStore } = await import("../src/store.js");
  const store = new JsonStore(path.join(tempDir, "orders.json"));
  const cards = store.createHCards({ count: 3, productId: 3 });

  assert.equal(cards.length, 3);
  assert.notEqual(cards[0].code, cards[1].code);
  assert.equal(store.listHCards().every(card => !("code" in card) && !("codeHash" in card)), true);
  assert.equal(store.verifyHCard(cards[0].code).ok, true);

  assert.equal(store.verifyHCard(cards[0].code).status, "unused");
  const firstOrder = store.createOrder({ provider: "h", status: "processing" });
  const firstReservation = store.reserveHCard(cards[0].code, firstOrder.id, {
    email: "first@example.com",
    accountId: "account_first"
  });
  assert.equal(firstReservation.ok, true);
  assert.equal(store.getHCardByCode(cards[0].code).status, "locked");
  assert.equal(store.getHCardByCode(cards[0].code).orderId, firstOrder.id);
  assert.equal(store.reserveHCard(cards[0].code, "order-2", {
    email: "first@example.com",
    accountId: "account_first"
  }).status, "locked");

  assert.equal(store.unlockHCard(firstReservation.cardId).status, "processing");
  store.updateOrder(firstOrder.id, { status: "failed" });
  assert.equal(store.unlockHCard(firstReservation.cardId).ok, true);
  assert.equal(store.verifyHCard(cards[0].code).ok, true);
  const secondReservation = store.reserveHCard(cards[0].code, "order-2", {
    email: "new@example.com",
    accountId: "account_new"
  });
  assert.equal(secondReservation.ok, true);
  const listedAfterRebind = store.listHCards().find(card => card.id === cards[0].id);
  assert.equal(listedAfterRebind.status, "locked");
  assert.equal(listedAfterRebind.boundEmail, "new@example.com");
  assert.equal(listedAfterRebind.boundAccountId, "account_new");

  const secondId = store.getHCardByCode(cards[1].code).id;
  assert.equal(store.setHCardDisabled(secondId, true, "人工暂停").status, "disabled");
  assert.equal(store.verifyHCard(cards[1].code).status, "disabled");
  assert.equal(store.setHCardDisabled(secondId, false).status, "unused");
  assert.equal(store.verifyHCard(cards[1].code).ok, true);

  const third = store.reserveHCard(cards[2].code, "order-3", {
    email: "third@example.com",
    accountId: "account_third"
  });
  assert.equal(third.ok, true);
  assert.equal(store.completeHCard(third.cardId, "wrong-order"), false);
  assert.equal(store.completeHCard(third.cardId, "order-3"), true);
  assert.equal(store.verifyHCard(cards[2].code).status, "used");
  assert.equal(store.unlockHCard(third.cardId).status, "used");
});
