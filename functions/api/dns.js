export async function onRequest(context) {
  const url = new URL(context.request.url);
  const name = url.searchParams.get("name") || "example.com";
  const type = (url.searchParams.get("type") || "A").toUpperCase();
  const doh = new URL("https://dns.google/resolve");
  doh.searchParams.set("name", name);
  doh.searchParams.set("type", type);
  const res = await fetch(doh, { headers: { accept: "application/dns-json" } });
  const data = await res.json();
  return Response.json({
    name,
    type,
    status: data.Status,
    answer: data.Answer || [],
    authority: data.Authority || [],
    raw: data,
  });
}
