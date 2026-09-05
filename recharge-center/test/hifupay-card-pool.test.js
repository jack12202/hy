import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("hifupay card pool enforces four Plus slots and keeps account upgrade windows", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-hifupay-pool-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const { JsonStore } = await import("../src/store.js");
  const store = new JsonStore(path.join(tempDir, "orders.json"));
  store.syncHifupayCards([
    { id: "7172", lastFour: "4113", status: "active", balance: 66, expiryDate: "09/28" },
    { id: "7667", lastFour: "6737", status: "active", balance: 17, expiryDate: "09/28" }
  ]);

  for (let index = 1; index <= 4; index += 1) {
    const reservation = store.reserveHifupayCard({
      orderId: `plus-${index}`,
      plan: "plus",
      identity: { email: `user${index}@example.com`, accountId: `account-${index}` },
      estimatedChargeUsd: 16,
      preferredCardId: "7172"
    });
    assert.equal(reservation.ok, true);
    assert.equal(reservation.hifupayCardId, "7172");
    store.recordHifupayResult({
      cardId: "7172",
      orderId: `plus-${index}`,
      plan: "plus",
      identity: { email: `user${index}@example.com`, accountId: `account-${index}` },
      paymentConfirmed: true,
      status: "success"
    });
  }

  const fullCard = store.listHifupayCards().find(card => card.id === "7172");
  assert.equal(fullCard.plusUsed, 4);
  assert.equal(fullCard.plusRemaining, 0);
  assert.equal(fullCard.poolStatus, "full_hold");
  assert.equal(fullCard.plusUsers.length, 4);

  const fifth = store.reserveHifupayCard({
    orderId: "plus-5",
    plan: "plus",
    identity: { email: "user5@example.com", accountId: "account-5" },
    estimatedChargeUsd: 16,
    preferredCardId: "7172"
  });
  assert.equal(fifth.ok, false);
  assert.equal(fifth.status, "unavailable");

  const upgrade = store.reserveHifupayCard({
    orderId: "pro-1",
    plan: "pro_x20",
    identity: { email: "user1@example.com", accountId: "account-1" },
    estimatedChargeUsd: 16,
    preferredCardId: "7172"
  });
  assert.equal(upgrade.ok, true);
  assert.equal(upgrade.hifupayCardId, "7172");
  store.recordHifupayResult({
    cardId: "7172",
    orderId: "pro-1",
    plan: "pro_x20",
    identity: { email: "user1@example.com", accountId: "account-1" },
    paymentConfirmed: true,
    status: "success"
  });

  const upgraded = store.listHifupayCards().find(card => card.id === "7172");
  assert.equal(upgraded.plusUsed, 4);
  assert.equal(upgraded.plusUsers.find(user => user.email === "user1@example.com").proAt !== "", true);

  const lowBalanceFallback = store.reserveHifupayCard({
    orderId: "plus-low-balance",
    plan: "plus",
    identity: { email: "user6@example.com", accountId: "account-6" },
    estimatedChargeUsd: 16,
    preferredCardId: "7667"
  });
  assert.equal(lowBalanceFallback.ok, false);
  assert.equal(lowBalanceFallback.status, "unavailable");
});
