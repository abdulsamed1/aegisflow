/**
 * Durable Object Atomic Lock Actor
 * Conforms to Architectural Invariant AD-5 + brief section 9 (crash-safe lease)
 */

const LOCK_TTL_MS = 5 * 60 * 1000;

export class JobLockDO {
  state: DurableObjectState;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/acquire") {
      const isSealed = await this.state.storage.get<boolean>("sealed");
      if (isSealed) {
        return new Response(JSON.stringify({ acquired: false, reason: "Job permanently sealed (BOOKED)" }), {
          status: 409,
          headers: { "Content-Type": "application/json" }
        });
      }

      const isLocked = await this.state.storage.get<boolean>("locked");
      if (isLocked) {
        const lockedAt = (await this.state.storage.get<number>("locked_at")) || 0;
        const expired = Date.now() - lockedAt > LOCK_TTL_MS;
        if (!expired) {
          return new Response(JSON.stringify({ acquired: false, reason: "Lock currently held by another task" }), {
            status: 409,
            headers: { "Content-Type": "application/json" }
          });
        }
        // Stale lock from a crashed execution: take over
      }

      await this.state.storage.put("locked", true);
      await this.state.storage.put("locked_at", Date.now());

      return new Response(JSON.stringify({ acquired: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/release") {
      await this.state.storage.delete("locked");
      await this.state.storage.delete("locked_at");
      return new Response(JSON.stringify({ released: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/seal") {
      await this.state.storage.put("sealed", true);
      await this.state.storage.delete("locked");
      await this.state.storage.delete("locked_at");
      return new Response(JSON.stringify({ sealed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
