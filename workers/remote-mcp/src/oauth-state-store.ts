/**
 * Single-use OAuth authorization state backed by a Durable Object.
 *
 * Cloudflare KV is eventually consistent and cannot atomically get-and-delete
 * a value. A Durable Object serializes access to each state key, so concurrent
 * callbacks cannot both provision credentials or mint authorization codes.
 */

const STATE_STORAGE_KEY = "oauth_request";
const STATE_TTL_MS = 10 * 60 * 1000;
const INTERNAL_ORIGIN = "https://oauth-state.internal";

export class OAuthStateStore {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    return this.state.blockConcurrencyWhile(async () => {
      if (request.method === "PUT" && pathname === "/state") {
        if (await this.state.storage.get(STATE_STORAGE_KEY)) {
          return new Response(null, { status: 409 });
        }
        const payload = await request.text();
        if (!payload) return new Response(null, { status: 400 });
        await this.state.storage.put(STATE_STORAGE_KEY, payload);
        await this.state.storage.setAlarm(Date.now() + STATE_TTL_MS);
        return new Response(null, { status: 204 });
      }

      if (request.method === "POST" && pathname === "/consume") {
        const payload = await this.state.storage.get<string>(STATE_STORAGE_KEY);
        if (!payload) return new Response(null, { status: 404 });
        await this.state.storage.deleteAll();
        return new Response(payload, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
          },
        });
      }

      return new Response(null, { status: 405 });
    });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

function stateStub(namespace: DurableObjectNamespace, stateKey: string): DurableObjectStub {
  return namespace.get(namespace.idFromName(stateKey));
}

export async function storeOAuthState(
  namespace: DurableObjectNamespace,
  stateKey: string,
  payload: string,
): Promise<void> {
  const response = await stateStub(namespace, stateKey).fetch(`${INTERNAL_ORIGIN}/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  if (!response.ok) {
    throw new Error(`OAuth state store rejected a new state (${response.status})`);
  }
}

export async function consumeOAuthState<T>(
  namespace: DurableObjectNamespace,
  stateKey: string,
): Promise<T | undefined> {
  const response = await stateStub(namespace, stateKey).fetch(`${INTERNAL_ORIGIN}/consume`, {
    method: "POST",
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`OAuth state store failed to consume state (${response.status})`);
  }
  return response.json<T>();
}
