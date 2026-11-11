// GET /api/quality
// 只查访问者自己的 IP（不接受 ?ip= 参数，避免被拿来批量查别人、耗尽免费额度）。
// 数据来源：
//   1) Cloudflare 边缘自带：request.cf（国家/城市/ASN/组织/时区），零外部请求。
//   2) ip-api.com 免费版：proxy / hosting / mobile 等情报字段，无需 key。
//      免费版只能走 HTTP（不能 HTTPS）、限流 45 次/分钟、禁商用，
//      所以由 Worker 在服务端调它（浏览器直接调会被 HTTPS 页面拦下），
//      并用 Cache API 按 IP 缓存 1 小时，减少重复调用。
// 风险是三档近似，不是 ping0 的风控百分比：
//   proxy=true → 高风险；hosting=true → 中风险；其余 → 低风险。
// ip-api 挂了 / 限流了就降级：只返回 Cloudflare 边缘信息，风险标“未知”，
// 首页不会因此挂掉。
export async function onRequest(context) {
  const { request } = context;
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "";
  const cf = request.cf || {};

  const edge = {
    country: cf.country || request.headers.get("cf-ipcountry") || null,
    city: cf.city || null,
    region: cf.region || null,
    timezone: cf.timezone || null,
    asn: cf.asn ?? null,
    asOrganization: cf.asOrganization || null,
    colo: cf.colo || null,
  };

  if (!ip) {
    return Response.json({ ip: "", ...edge, quality: null, error: "无法读取访问者 IP" }, { status: 500 });
  }

  // 先读缓存（Pages Functions 里有 Cache API；本地 Node 测试时没有，要容错）
  const cacheKey = `https://quality-cache.local/${encodeURIComponent(ip)}`;
  try {
    if (typeof caches !== "undefined" && caches.default) {
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        const data = await cached.json();
        return Response.json({ ...data, cached: true });
      }
    }
  } catch (e) {
    // 缓存读失败不影响主流程
  }

  let info = null;
  let source = "cloudflare-edge-only";
  try {
    const fields = [
      "status", "message", "query", "country", "countryCode", "regionName",
      "city", "isp", "org", "as", "mobile", "proxy", "hosting", "timezone", "lat", "lon",
    ].join(",");
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${fields}&lang=zh-CN`,
      { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } }
    );
    if (res.status === 429) throw new Error("ip-api 限流（429）");
    if (!res.ok) throw new Error("ip-api 返回 " + res.status);
    const data = await res.json();
    if (data.status !== "success") throw new Error(data.message || "ip-api 查询失败");
    info = data;
    source = "ip-api.com + cloudflare-edge";
  } catch (e) {
    // 降级：只用边缘信息
    const fallback = {
      ip,
      ...edge,
      quality: {
        type: "未知",
        typeEn: "unknown",
        riskLevel: "unknown",
        riskText: "未知",
        proxy: null,
        hosting: null,
        mobile: null,
        note: "ip-api 暂不可用（" + (e?.message || e) + "），仅显示 Cloudflare 边缘信息。",
      },
      source,
      degraded: true,
    };
    return Response.json(fallback);
  }

  const proxy = info.proxy === true;
  const hosting = info.hosting === true;
  const mobile = info.mobile === true;

  const type = proxy
    ? "代理 / VPN / Tor 出口"
    : hosting
      ? "数据中心 / IDC 机房"
      : mobile
        ? "移动网络"
        : "家庭宽带 / 住宅";
  const riskLevel = proxy ? "high" : hosting ? "medium" : "low";
  const riskText = proxy ? "高风险" : hosting ? "中风险" : "低风险";

  const result = {
    ip,
    country: info.country || edge.country,
    countryCode: info.countryCode || edge.country,
    region: info.regionName || edge.region,
    city: info.city || edge.city,
    timezone: info.timezone || edge.timezone,
    latitude: info.lat ?? cf.latitude ?? null,
    longitude: info.lon ?? cf.longitude ?? null,
    asn: info.as || (edge.asn ? "AS" + edge.asn : null),
    asOrganization: info.org || info.isp || edge.asOrganization,
    isp: info.isp || null,
    colo: edge.colo,
    quality: {
      type,
      typeEn: proxy ? "proxy" : hosting ? "hosting" : mobile ? "mobile" : "residential",
      riskLevel,
      riskText,
      proxy,
      hosting,
      mobile,
      note: "三档近似风险，不是 ping0 的风控百分比；proxy/hosting 判断来自 ip-api.com 免费版。",
    },
    source,
    degraded: false,
  };

  // 写缓存 1 小时（失败不影响返回）
  try {
    if (typeof caches !== "undefined" && caches.default) {
      const toCache = new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json", "cache-control": "max-age=3600" },
      });
      await caches.default.put(cacheKey, toCache);
    }
  } catch (e) {}

  return Response.json({ ...result, cached: false });
}
