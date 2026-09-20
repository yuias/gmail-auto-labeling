export { Mailbox } from "./mailbox";

async function fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") {
    return new Response("ok", { status: 200 });
  }
  return new Response(null, { status: 404 });
}

export default { fetch };
