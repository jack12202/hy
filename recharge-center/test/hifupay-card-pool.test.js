import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("hifupay card pool fills cards in order and switches using live balance", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-hifupay-pool-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const { JsonStore } = await import("../src/store.js");
  const store = new JsonStore(path.join(tempDir, "orders.json"));
  store.syncHifupayCards([
    { id: "7172", lastFour: "4113", status: "active", balance: 50 },
    { id: "7667", lastFour: "6737", status: "active", balance: 66 }
  ]);

  // 第一张卡手动充值一次后余额为 $50，后续无需登记手动名额。
  for (let index = 1; index <= 3; index += 1) {
    const reservation = store.reserveHifupayCard({
      orderId: `plus-${index}`, plan: "plus",
      identity: { email: `user${index}@example.com` }, estimatedChargeUsd: 16,
      preferredCardId: "7172"
    });
    assert.equal(reservation.hifupayCardId, "7172");
    store.syncHifupayCards([
      { id: "7172", lastFour: "4113", status: "active", balance: Math.round((50 - index * 15.77) * 100) / 100 },
      { id: "7667", lastFour: "6737", status: "active", balance: 66 }
    ]);
    store.recordHifupayResult({ cardId: "7172", orderId: `plus-${index}`, plan: "plus", identity: { email: `user${index}@example.com` }, paymentConfirmed: true, status: "success" });
  }

  const first = store.listHifupayCards().find(card => card.id === "7172");
  assert.equal(first.balance, 2.69);
  assert.equal(first.poolStatus, "low_balance");
  assert.equal(first.automaticPlusUsed, 3);
  assert.equal(store.getHifupayEstimatedCharge("plus"), 15.77);

  const switched = store.reserveHifupayCard({ orderId: "plus-4", plan: "plus", identity: { email: "user4@example.com" }, estimatedChargeUsd: 16, preferredCardId: "7172" });
  assert.equal(switched.ok, true);
  assert.equal(switched.hifupayCardId, "7667");

  store.clearHifupayReservation("7667", "plus-4");
  store.syncHifupayCards([
    { id: "7172", lastFour: "4113", status: "active", balance: 2.69 },
    { id: "7667", lastFour: "6737", status: "active", balance: 15.76 }
  ]);
  const unavailable = store.reserveHifupayCard({ orderId: "plus-low", plan: "plus", identity: { email: "user5@example.com" }, estimatedChargeUsd: 16 });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.status, "unavailable");

  store.syncHifupayCards([
    { id: "7172", lastFour: "4113", status: "active", balance: 2.69 },
    { id: "7667", lastFour: "6737", status: "active", balance: 16.5 }
  ]);
  const enough = store.reserveHifupayCard({ orderId: "plus-enough", plan: "plus", identity: { email: "user6@example.com" }, estimatedChargeUsd: store.getHifupayEstimatedCharge("plus") });
  assert.equal(enough.ok, true);
  assert.equal(enough.hifupayCardId, "7667");
});
