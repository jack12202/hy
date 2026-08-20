# gptc.cc 自动部署到 VPS

这个仓库已经配置了 GitHub Actions 自动部署，并且直接通过 `1Panel API` 把首页和博客同步到 VPS。

触发方式：
- `push` 到 `main`
- GitHub Actions 页面手动点 `Run workflow`

## 需要配置的 GitHub Secrets

在仓库 `Settings -> Secrets and variables -> Actions` 里新增：

- `PANEL_BASE`
  - 当前 VPS：`http://72.11.133.197:37764`
- `PANEL_ENTRANCE`
  - 1Panel 安全入口路径，保存在 GitHub Secret 中
- `PANEL_USER`
  - 1Panel 登录用户名，保存在 GitHub Secret 中
- `PANEL_PASS`
  - 你的 1Panel 登录密码
- `PANEL_TARGET_DIR`
  - 例：`/opt/1panel/apps/openresty/openresty/www/sites/gptc.cc/index/gptccc-main`

## 部署范围

工作流会自动同步这些内容：

- `index.html`
- `robots.txt`
- `sitemap.xml`
- `activate/index.html`
- `blog/`

## 当前不会覆盖的内容

这套自动部署**不会删除或覆盖**服务器上单独维护的：

- `activate/` 目录下除 `index.html` 之外的其他文件

这样你的博客、首页和充值页主文件都可以继续自动发布，同时保留未来给 `activate/` 增加其他资源文件的空间。

## 多源头充值后端

`recharge-center/` 是统一充值后端，已经支持：

- 站内充值
  - 三哥：`sange`
  - 阿妍：`ayan`
  - 廖（用户端显示 `l`）：`czgpt`
- 站外充值
  - 三哥：`sange_external`
  - 阿妍：`ayan_external`
  - 廖（用户端显示 `l`）：`czgpt_external`
  - 白：`dnscon`
  - 七七：`9977ai`
- 后台默认源头切换：`/admin/provider`
- 激活链接显式指定源头：`/activate/?provider=ayan&card=XXXX`

后端服务需要单独在 VPS 上运行，并配置这些环境变量：

- `DEFAULT_PROVIDER`
  - 默认值：`czgpt`
  - 可选值：`sange` / `ayan` / `czgpt` / `sange_external` / `ayan_external` / `czgpt_external` / `dnscon` / `9977ai`
- `ADMIN_TOKEN`
  - 手机后台切换源头时输入的管理密码
- `AYAN_BASE_URL`
  - 默认值：`https://api.987ai.vip`
- `UPSTREAM_BASE_URL`
  - 三哥接口地址，默认值：`https://kkk.ow800.com`
- `UPSTREAM_AUTH_TOKEN`
  - 如果三哥接口需要鉴权，在这里配置
- `RESELLER_BASE_URL`
  - l 通道的分销商 API 地址，默认值：`https://666ai.vip`

手机切换入口：

- `https://gptc.cc/admin/provider`

手机私密后台链接：

- `https://gptc.cc/admin/provider#token=你的ADMIN_TOKEN`

打开后不用输入账号密码，先选择“站内充值”或“站外充值”，再点对应源头即可切换。站内充值留在 GPTC 完成；站外充值会在用户访问激活页时自动跳到所选源头。推荐使用 `#token=`，这样 token 不会发送到服务器日志里。

手机一键切换链接（旧方式，会把 token 放进请求 URL，不建议长期保存）：

- 切到三哥：`https://gptc.cc/admin/provider/switch?provider=sange&token=你的ADMIN_TOKEN`
- 切到阿妍：`https://gptc.cc/admin/provider/switch?provider=ayan&token=你的ADMIN_TOKEN`
- 切到廖（站内）：`https://gptc.cc/admin/provider/switch?provider=czgpt&token=你的ADMIN_TOKEN`
- 切到站外三哥：`https://gptc.cc/admin/provider/switch?provider=sange_external&token=你的ADMIN_TOKEN`
- 切到站外阿妍：`https://gptc.cc/admin/provider/switch?provider=ayan_external&token=你的ADMIN_TOKEN`
- 切到廖（站外）：`https://gptc.cc/admin/provider/switch?provider=czgpt_external&token=你的ADMIN_TOKEN`
- 切到白：`https://gptc.cc/admin/provider/switch?provider=dnscon&token=你的ADMIN_TOKEN`
- 切到七七：`https://gptc.cc/admin/provider/switch?provider=9977ai&token=你的ADMIN_TOKEN`

这些链接不需要账号密码，但 `ADMIN_TOKEN` 必须足够长、不要发给别人。

上线时要确认 Nginx / OpenResty 已把 `/api/recharge/*` 和 `/admin/provider` 转发到 `recharge-center` 后端服务。
