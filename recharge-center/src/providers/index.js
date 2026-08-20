import { normalizeProvider } from "../utils.js";
import { ayanAdapter } from "./ayan-adapter.js";
import { czgptAdapter } from "./czgpt-adapter.js";
import {
  ai9977Adapter,
  ayanExternalAdapter,
  czgptExternalAdapter,
  dnsconAdapter,
  sangeExternalAdapter,
  xiaoyuProxyAdapter
} from "./redirect-adapters.js";
import { sangeAdapter } from "./sange-adapter.js";
import { xiaoyuAdapter } from "./xiaoyu-adapter.js";

export const providerAdapters = {
  sange: sangeAdapter,
  ayan: ayanAdapter,
  czgpt: czgptAdapter,
  xiaoyu: xiaoyuAdapter,
  xiaoyu_proxy: xiaoyuProxyAdapter,
  sange_external: sangeExternalAdapter,
  ayan_external: ayanExternalAdapter,
  czgpt_external: czgptExternalAdapter,
  dnscon: dnsconAdapter,
  "9977ai": ai9977Adapter
};

export function getProviderAdapter(provider) {
  return providerAdapters[normalizeProvider(provider)];
}

export function listProviders() {
  return Object.values(providerAdapters).map(adapter => ({
    key: adapter.key,
    label: adapter.label,
    mode: adapter.mode || "api",
    location: adapter.mode === "redirect" ? "external" : adapter.mode === "proxy" ? "proxy" : "internal"
  }));
}
