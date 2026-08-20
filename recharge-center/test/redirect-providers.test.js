import assert from "node:assert/strict";
import test from "node:test";
import { getProviderAdapter, listProviders } from "../src/providers/index.js";

test("external providers are available as redirect routes", async () => {
  const providers = listProviders();
  assert.deepEqual(
    providers.filter(provider => provider.mode === "redirect"),
    [
      { key: "sange_external", label: "三哥", mode: "redirect", location: "external" },
      { key: "ayan_external", label: "阿妍", mode: "redirect", location: "external" },
      { key: "czgpt_external", label: "l", mode: "redirect", location: "external" },
      { key: "dnscon", label: "白", mode: "redirect", location: "external" },
      { key: "9977ai", label: "七七", mode: "redirect", location: "external" }
    ]
  );

  const white = getProviderAdapter("dnscon");
  const result = await white.verifyCard({ cardInfo: "TEST" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.data.redirectUrl, "https://dnscon.xyz/");

  const externalRoutes = Object.fromEntries(
    providers
      .filter(provider => provider.mode === "redirect")
      .map(provider => [provider.key, getProviderAdapter(provider.key).redirectUrl])
  );
  assert.deepEqual(externalRoutes, {
    sange_external: "https://ow800.com/auto",
    ayan_external: "https://987ai.vip/recharge",
    czgpt_external: "https://666ai.vip/",
    dnscon: "https://dnscon.xyz/",
    "9977ai": "https://9977ai.vip/"
  });
});
