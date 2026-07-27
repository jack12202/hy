import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

test("l channel adapter verifies, starts and polls a GPT Pro task", async t => {
  let pollCount = 0;
  let cardStatusCount = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/kami/status") {
      const code = await readBody(req);
      assert.equal(req.headers["content-type"], "text/plain");
      cardStatusCount += 1;
      const status = code === "G20XFAILEDTASK"
        ? "used"
        : code === "G20XTIMEDOUT"
          ? "unused"
          : cardStatusCount === 1
            ? "unused"
            : "used";
      sendJson(res, 200, [{
        code,
        status,
        is_distributed: true,
        type: "gpt_pro_20x",
        bound_email: status === "used" ? "test@example.com" : null,
        used_at: status === "used" ? "2026-07-27T01:02:03Z" : null
      }]);
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/kami/use") {
      const payload = JSON.parse(await readBody(req));
      assert.equal(payload.code, "G20XTESTCODE1234");
      assert.equal(payload.session.user.email, "test@example.com");
      assert.equal(payload.session.account.id, "account_test");
      assert.equal(payload.session.accessToken, "token_test");
      sendJson(res, 200, {
        task_id: "task-test",
        code: payload.code,
        status: "bound",
        message: "任务已创建"
      });
      return;
    }

    if (req.method === "GET" && req.url === "/api/v1/kami/task/task-test") {
      pollCount += 1;
      sendJson(res, 200, {
        id: "task-test",
        status: pollCount === 1 ? "working" : "succeeded",
        message: pollCount === 1 ? "处理中" : "充值成功",
        remaining_seconds: pollCount === 1 ? 47 : 0,
        queue_ahead: pollCount === 1 ? 3 : 0
      });
      return;
    }

    if (req.method === "GET" && req.url === "/api/v1/kami/task/task-pending") {
      sendJson(res, 200, {
        id: "task-pending",
        status: "pending",
        message: "等待处理",
        remaining_seconds: 90,
        queue_ahead: 5
      });
      return;
    }

    if (req.method === "GET" && req.url === "/api/v1/kami/task/task-failed") {
      sendJson(res, 200, {
        id: "task-failed",
        status: "failed",
        message: "任务返回失败"
      });
      return;
    }

    if (req.method === "GET" && req.url === "/api/v1/kami/task/task-timeout") {
      sendJson(res, 200, {
        id: "task-timeout",
        status: "timeout",
        message: "任务查询超时"
      });
      return;
    }

    sendJson(res, 404, { detail: "Not found" });
  });

  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const address = upstream.address();
  process.env.RESELLER_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.DATA_FILE = path.join(os.tmpdir(), `gptc-czgpt-test-${Date.now()}.json`);
  t.after(() => fs.rmSync(process.env.DATA_FILE, { force: true }));

  const { czgptAdapter } = await import(`../src/providers/czgpt-adapter.js?test=${Date.now()}`);
  const verified = await czgptAdapter.verifyCard({ cardInfo: "G20XTESTCODE1234" });
  assert.equal(verified.ok, true);
  assert.equal(verified.data.cardType, "gpt_pro_20x");

  const started = await czgptAdapter.startRecharge({
    cardInfo: "G20XTESTCODE1234",
    fullAuthData: {
      user: { id: "user_test", email: "test@example.com" },
      account: { id: "account_test", planType: "free" },
      accessToken: "token_test"
    }
  });
  assert.equal(started.ok, true);
  assert.equal(started.data.taskId, "task-test");

  const cardStatus = await czgptAdapter.queryCardStatus({ cardInfo: "G20XTESTCODE1234" });
  assert.equal(cardStatus.ok, true);
  assert.equal(cardStatus.data.cardStatus, "used");
  assert.equal(cardStatus.data.boundEmailMasked, "te…t@example.com");
  assert.equal(cardStatus.data.usedAt, "2026-07-27T01:02:03Z");

  const working = await czgptAdapter.queryTaskStatus({ taskId: "task-test" });
  assert.equal(working.data.status, "processing");
  assert.equal(working.data.queueAhead, 3);
  assert.equal(working.data.remainingSeconds, 47);

  const succeeded = await czgptAdapter.queryTaskStatus({ taskId: "task-test" });
  assert.equal(succeeded.data.status, "success");

  const pending = await czgptAdapter.queryTaskStatus({ taskId: "task-pending" });
  assert.equal(pending.data.status, "queued");
  assert.equal(pending.data.queueAhead, 5);

  pollCount = 0;
  const { rechargeService } = await import(`../src/recharge-service.js?test=${Date.now()}`);
  const serviceStatus = await rechargeService.queryTaskStatus({
    taskId: "task-test",
    provider: "czgpt"
  });
  assert.equal(serviceStatus.ok, true);
  assert.equal(serviceStatus.data.queueAhead, 3);
  assert.equal(serviceStatus.data.remainingSeconds, 47);

  const serviceCardStatus = await rechargeService.queryCardStatus("G20XTESTCODE1234", "czgpt");
  assert.equal(serviceCardStatus.ok, true);
  assert.equal(serviceCardStatus.data.cardStatus, "used");

  const reconciledUsedCard = await rechargeService.queryTaskStatus({
    taskId: "task-failed",
    provider: "czgpt",
    cardInfo: "G20XFAILEDTASK"
  });
  assert.equal(reconciledUsedCard.ok, true);
  assert.equal(reconciledUsedCard.data.status, "syncing");
  assert.equal(reconciledUsedCard.data.cardStatus, "used");

  const reconciledUnusedCard = await rechargeService.queryTaskStatus({
    taskId: "task-timeout",
    provider: "czgpt",
    cardInfo: "G20XTIMEDOUT"
  });
  assert.equal(reconciledUnusedCard.ok, true);
  assert.equal(reconciledUnusedCard.data.status, "needs_review");
  assert.equal(reconciledUnusedCard.data.cardStatus, "unused");
});
