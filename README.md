# ip-test-site

无服务器 IP 测试站，部署在 Cloudflare Pages。

## 功能

- 显示访问者 IP（`GET /api/ip`，读取 `cf-connecting-ip`）
- IP 质量（`GET /api/quality`，只查访问者自己的 IP）：Cloudflare 边缘 + ip-api.com 免费版，显示 IP 类型（住宅/移动/数据中心/代理）、代理/VPN/Tor、数据中心、风险三档（低/中/高）。风险是近似档位，不是 ping0 的风控百分比。ip-api 免费版只能走 HTTP、限流 45 次/分钟，由 Worker 在服务端调用并按 IP 缓存 1 小时；失败时降级只显示边缘信息。
- HTTP 延迟测试（`GET /api/ping?target=example.com`，边缘节点发起 3 次 HTTP 请求并计时，不是 ICMP）
- DNS 查询（`GET /api/dns?name=example.com&type=A`，通过 DNS-over-HTTPS 查询 dns.google）

## 本地开发

```bash
npx wrangler pages dev public
```

## 部署

将 GitHub 仓库连接到 Cloudflare Pages：Framework preset 选择 None，Build command 留空，Build output directory 填写 `public`。
