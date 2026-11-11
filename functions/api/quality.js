// GET /api/quality  或  GET /api/quality?ip=8.8.8.8
// 不传 ip 查访问者自己的 IP；传 ip 查任意公网 IP（首页搜索框用的就是这个）。
// 只接受公网 IPv4/IPv6，内网、回环、保留地址直接拒绝 400；
// 任意 IP 的查询同样按 IP 缓存 1 小时，省免费额度。
// 数据来源：
//   1) Cloudflare 边缘自带：request.cf（国家/城市/ASN/组织/时区），零外部请求。
//      注意：边缘信息只属于访问者本人，查任意 IP 时不拿它当目标的归属地。
//   2) ip-api.com 免费版：proxy / hosting / mobile 等情报字段，无需 key。
//      免费版只能走 HTTP（不能 HTTPS）、限流 45 次/分钟、禁商用，
//      所以由 Worker 在服务端调它（浏览器直接调会被 HTTPS 页面拦下），
//      并用 Cache API 按 IP 缓存 1 小时，减少重复调用。
// 风险是三档近似，不是 ping0 的风控百分比：
//   proxy=true → 高风险；hosting=true → 中风险；其余 → 低风险。
// ip-api 挂了 / 限流了就降级：查自己时只返回 Cloudflare 边缘信息，
// 查任意 IP 时只能返回“未知”，首页不会因此挂掉。
function isPublicIP(ip) {
  if (!ip) return false;
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    if (!/^[0-9a-f:]+$/.test(low) || low.split(":").length < 3) return false;
    if (low === "::1" || low === "::") return false;
    if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return false;
    if (low.startsWith("fc") || low.startsWith("fd")) return false;
    if (low.startsWith("::ffff:10.") || low.startsWith("::ffff:127.") || low.startsWith("::ffff:192.168.") || low.startsWith("::ffff:172.16.")) return false;
    return true;
  }
  const p = ip.split(".");
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || +x > 255)) return false;
  const [a, b] = p.map(Number);
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a >= 224) return false;
  return true;
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const visitorIp =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "";
  const requestedIp = (url.searchParams.get("ip") || "").trim();
  const ip = requestedIp || visitorIp;
  const isSelf = !requestedIp || requestedIp === visitorIp;

  if (!isPublicIP(ip)) {
    return Response.json(
      { ip: requestedIp || "", error: "IP 格式不正确，只支持公网 IPv4 / IPv6，内网、回环和保留地址不接受" },
      { status: 400 }
    );
  }

  const cf = request.cf || {};
  // 边缘信息只属于访问者本人；查任意 IP 时留空，别拿访问者的归属地冒充目标的
  const edge = isSelf
    ? {
        country: cf.country || request.headers.get("cf-ipcountry") || null,
        city: cf.city || null,
        region: cf.region || null,
        timezone: cf.timezone || null,
        asn: cf.asn ?? null,
        asOrganization: cf.asOrganization || null,
        colo: cf.colo || null,
      }
    : { country: null, city: null, region: null, timezone: null, asn: null, asOrganization: null, colo: cf.colo || null };

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
    // 降级：查自己时只用边缘信息；查任意 IP 时边缘信息不属于目标，只能标未知
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
        note: isSelf
          ? "ip-api 暂不可用（" + (e?.message || e) + "），仅显示 Cloudflare 边缘信息。"
          : "ip-api 暂不可用（" + (e?.message || e) + "），无法查到该 IP 的质量，请稍后再试。",
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
