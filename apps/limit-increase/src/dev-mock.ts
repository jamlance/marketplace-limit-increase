/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const u = new URL(url, location.origin);
    const json = (d: any) => new Response(JSON.stringify(d), { status: 200, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 70));

    if (u.pathname === "/api/state") return json({
      available: true,
      limits: {
        daily_limit: 10000, monthly_limit: 100000, single_limit: 10000, withdrawal_limit: 50000,
        usage_today: 7400, usage_month: 64200,
        active_overrides: [{ limit_kind: "daily", amount: 15000, expires_in_seconds: 4 * 86400 + 5 * 3600 }],
      },
    });
    if (u.pathname === "/api/request") return json({ pay_url: "https://example.com/pay/mock", fee: 35, reference_id: "limitinc-v1-mock" });
    if (u.pathname === "/api/confirm") return json({ ok: true, result: { limit_kind: "daily", amount: 15000 } });
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "bookerva-jackjack", name: "Jack Jack Barbershop", currency_code: "USD", email: "jack@example.com", logo: null },
    user: { id: 90, name: "Front Desk", email: "desk@jackjack.com" },
    scopes: ["reputation:read", "merchant_limits:request"],
  };
}
