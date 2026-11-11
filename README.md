# ip-test-site

无服务器 IP 测试站，部署在 Cloudflare Pages。

## 功能

- 显示访问者 IP（`GET /api/ip`，读取 `cf-connecting-ip`）
- HTTP 延迟测试（`GET /api/ping?target=example.com`，边缘节点发起 3 次 HTTP 请求并计时，不是 ICMP）
- DNS 查询（`GET /api/dns?name=example.com&type=A`，通过 DNS-over-HTTPS 查询 dns.google）

## 本地开发

```bash
npx wrangler pages dev public
```

## 部署

将 GitHub 仓库连接到 Cloudflare Pages：Framework preset 选择 None，Build command 留空，Build output directory 填写 `public`。
