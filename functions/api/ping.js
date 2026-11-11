export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = url.searchParams.get("target") || "example.com";
  const results = [];
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    try {
      const res = await fetch(`https://${target}`, { method: "GET", redirect: "follow" });
      results.push({ attempt: i + 1, ok: res.ok, status: res.status, ms: Date.now() - started });
    } catch (err) {
      try {
        const res = await fetch(`http://${target}`, { method: "GET", redirect: "follow" });
        results.push({ attempt: i + 1, ok: res.ok, status: res.status, ms: Date.now() - started });
      } catch (err2) {
        results.push({ attempt: i + 1, ok: false, status: 0, ms: Date.now() - started, error: String(err2) });
      }
    }
  }
  const okTimes = results.filter((r) => r.ok).map((r) => r.ms);
  const avgMs = okTimes.length ? Math.round(okTimes.reduce((a, b) => a + b, 0) / okTimes.length) : null;
  return Response.json({ target, count: 3, results, avgMs });
}
