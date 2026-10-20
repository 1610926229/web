# 公网登录 / 工作台请求的公共反代头（PROD-6 HTTPS 配置片段）。
#
# 与 `chaoge-proxy-public.inc` 唯一的区别：保留浏览器带来的 Cookie。
# 会话本身仍由应用校验——Nginx 只负责不把 Cookie 丢掉。
#
# ⚠️ 这里必须重复完整的 proxy_set_header 组，原因见 chaoge-proxy-public.inc 顶部。

proxy_http_version 1.1;
proxy_connect_timeout 5s;
proxy_send_timeout 30s;
proxy_read_timeout 30s;

proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
# 覆盖而不是追加，原因见 chaoge-proxy-public.inc。
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;

proxy_set_header X-Chaoge-Public-Preview "1";

# 登录 / 工作台 / 用户登录入口：会话 Cookie 必须到达应用。
proxy_set_header Cookie $http_cookie;
proxy_set_header Authorization "";

proxy_hide_header X-Powered-By;
