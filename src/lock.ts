/**
 * Durable Object Atomic Lock Actor
 * Conforms to Architectural Invariant AD-5
 */

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
        return new Response(JSON.stringify({ acquired: false, reason: "Lock currently held by another task" }), {
          status: 409,
          headers: { "Content-Type": "application/json" }
        });
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
      return new Response(JSON.stringify({ sealed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
