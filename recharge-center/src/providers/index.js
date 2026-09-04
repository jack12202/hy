import { normalizeProvider } from "../utils.js";
import { ajianAdapter } from "./ajian-adapter.js";
import { ayanAdapter } from "./ayan-adapter.js";
import { czgptAdapter } from "./czgpt-adapter.js";
import {
  ai9977Adapter,
  ayanExternalAdapter,
  czgptExternalAdapter,
  dnsconAdapter,
  sangeExternalAdapter
} from "./redirect-adapters.js";
import { sangeAdapter } from "./sange-adapter.js";
import { xiaoyuAdapter } from "./xiaoyu-adapter.js";
import { hifupayAdapter } from "./hifupay-adapter.js";

export const providerAdapters = {
  sange: sangeAdapter,
  ayan: ayanAdapter,
  j: ajianAdapter,
  czgpt: czgptAdapter,
  xiaoyu: xiaoyuAdapter,
  h: hifupayAdapter,
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
    location: adapter.mode === "redirect" ? "external" : "internal"
  }));
}
