export async function onRequest(context) {
  const ip = context.request.headers.get("cf-connecting-ip") || "";
  return Response.json({ ip });
}
