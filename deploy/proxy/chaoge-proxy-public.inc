# 公网只读请求的公共反代头（PROD-6 HTTPS 配置片段）。
#
# 由 `chaoge-public-https.conf.template` 通过
#     include snippets/chaoge-proxy-public.inc;
# 引入到每个「匿名只读」location。
#
# ⚠️ 不要在 server 级写 `proxy_set_header` 后再只在某个 location 覆盖 Cookie：
# Nginx 的继承规则是「当前层级一旦出现任何 proxy_set_header，就不再继承上层
# 的全部 proxy_set_header」。那会让登录 location 悄悄丢掉 Host / X-Forwarded-*，
# 表现为 Cookie 仍然可用但 CSRF 同源校验失败、审计 IP 变成 127.0.0.1。
# 因此每个 location 显式 include 完整的一组头。

proxy_http_version 1.1;
proxy_connect_timeout 5s;
proxy_send_timeout 30s;
proxy_read_timeout 30s;

proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
# ⚠️ 覆盖而不是追加：`$proxy_add_x_forwarded_for` 会保留客户端自带的 XFF，
# 应用按第一段限流时，攻击者可以每次伪造一个新的第一段来绕过 IP 额度。
# 这里只有一个可信代理（Nginx 自己），所以直接用 $remote_addr。
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;

# 应用据此进入公网策略：只读路径 + 登录 / 工作台路径都带这个头。
proxy_set_header X-Chaoge-Public-Preview "1";

# 匿名只读：绝不携带任何会话或凭据。
proxy_set_header Cookie "";
proxy_set_header Authorization "";

proxy_hide_header X-Powered-By;
