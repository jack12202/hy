function makeRedirectAdapter({ key, label, redirectUrl }) {
  function redirectResult() {
    return {
      ok: false,
      status: 409,
      data: {
        success: false,
        provider: key,
        providerLabel: label,
        providerMode: "redirect",
        redirectUrl,
        message: `当前已切换到站外充值 · ${label}，正在打开对应页面。`
      }
    };
  }

  return {
    key,
    label,
    mode: "redirect",
    redirectUrl,
    verifyCard: redirectResult,
    startRecharge: redirectResult,
    queryTaskStatus: redirectResult
  };
}

function makeProxyAdapter({ key, label, redirectUrl }) {
  function proxyResult() {
    return {
      ok: false,
      status: 409,
      data: {
        success: false,
        provider: key,
        providerLabel: label,
        providerMode: "proxy",
        redirectUrl,
        message: `当前已切换到反代充值 · ${label}，正在打开对应页面。`
      }
    };
  }

  return {
    key,
    label,
    mode: "proxy",
    redirectUrl,
    verifyCard: proxyResult,
    startRecharge: proxyResult,
    queryTaskStatus: proxyResult
  };
}

export const xiaoyuProxyAdapter = makeProxyAdapter({
  key: "xiaoyu_proxy",
  label: "小雨",
  redirectUrl: "/self-recharge"
});

export const sangeExternalAdapter = makeRedirectAdapter({
  key: "sange_external",
  label: "三哥",
  redirectUrl: "https://ow800.com/auto"
});

export const ayanExternalAdapter = makeRedirectAdapter({
  key: "ayan_external",
  label: "阿妍",
  redirectUrl: "https://987ai.vip/recharge"
});

export const czgptExternalAdapter = makeRedirectAdapter({
  key: "czgpt_external",
  label: "l",
  redirectUrl: "https://666ai.vip/"
});

export const dnsconAdapter = makeRedirectAdapter({
  key: "dnscon",
  label: "白",
  redirectUrl: "https://dnscon.xyz/"
});

export const ai9977Adapter = makeRedirectAdapter({
  key: "9977ai",
  label: "七七",
  redirectUrl: "https://9977ai.vip/"
});
