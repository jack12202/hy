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
  assert.equal(store.listHCards(1).length, 1);
  assert.equal(store.listHCards(1, true).length, 3);
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

test("submitted h cards can only be archived while untouched cards can be deleted", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-h-card-delete-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const { JsonStore } = await import("../src/store.js");
  const store = new JsonStore(path.join(tempDir, "orders.json"));
  const [submitted, untouched] = store.createHCards({ count: 2 });
  const order = store.createOrder({ provider: "h", status: "failed" });
  store.createRechargeSession({ orderId: order.id, userEmail: "buyer@example.com", rawSecretCiphertext: "encrypted" });
  const reserved = store.reserveHCard(submitted.code, order.id, { email: "buyer@example.com", accountId: "account" });

  assert.equal(reserved.ok, true);
  assert.equal(store.deleteHCard(reserved.cardId).status, "has_submission");
  assert.equal(store.archiveHCard(reserved.cardId, true).ok, true);
  assert.equal(store.listHCards(100, true, false).some(card => card.id === reserved.cardId), false);
  assert.equal(store.listHCards(100, true, false, true).find(card => card.id === reserved.cardId).archivedAt.length > 0, true);
  assert.equal(store.verifyHCard(submitted.code).status, "archived");
  assert.equal(store.reserveHCard(submitted.code, order.id, { email: "buyer@example.com", accountId: "account" }).status, "archived");
  assert.equal(store.archiveHCard(reserved.cardId, false).ok, true);

  const untouchedId = store.getHCardByCode(untouched.code).id;
  assert.equal(store.deleteHCard(untouchedId).ok, true);
  assert.equal(store.getHCardByCode(untouched.code), null);
});

test("all recharge records are listed and successful secrets expire after 45 days", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-recharge-record-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dataFile = path.join(tempDir, "orders.json");
  const { JsonStore } = await import("../src/store.js");
  const store = new JsonStore(dataFile);
  const success = store.createOrder({ provider: "h", status: "success" });
  const failed = store.createOrder({ provider: "j", status: "failed" });
  store.createRechargeSession({ orderId: success.id, userEmail: "success@example.com", rawSecretCiphertext: "old-secret" });
  store.createRechargeSession({ orderId: failed.id, userEmail: "failed@example.com", rawSecretCiphertext: "keep-secret" });
  const state = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  state.orders.find(item => item.id === success.id).updatedAt = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(dataFile, JSON.stringify(state, null, 2));

  const records = store.listRechargeOrders();
  assert.equal(records.length, 2);
  assert.equal(records.find(item => item.id === success.id).hasOriginalJson, false);
  assert.equal(records.find(item => item.id === failed.id).hasOriginalJson, true);
});
