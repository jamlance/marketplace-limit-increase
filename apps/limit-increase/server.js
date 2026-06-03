import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi } from "@inkress/apps-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[limit-increase] Missing env: ${k}`); process.exit(1); }
}

const app = express();
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
});

// Current limits + usage + active overrides (reputation:read).
app.get("/api/state", core.requireSession, async (req, res) => {
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, "merchants/reputation");
    const rep = r?.result || r?.data || r || {};
    res.json({ limits: rep.limits || {}, standing: rep.standing, available: true });
  } catch (err) {
    res.json({ limits: {}, available: false, reason: err?.message });
  }
});

// Request + approval history (reputation:read).
app.get("/api/history", core.requireSession, async (req, res) => {
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, "merchants/limit-increase-requests");
    const rows = r?.result || r?.data || [];
    res.json({ requests: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    res.json({ requests: [], reason: err?.message });
  }
});

// Open a paid increase request → returns the hosted-checkout pay link.
app.post("/api/request", core.requireSession, express.json(), async (req, res) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  const body = {
    limit_kind: req.body?.limit_kind || "daily",
    amount: req.body?.amount,
    duration_days: req.body?.duration_days,
    reason: req.body?.reason,
    proof: req.body?.proof,
    return_base: origin,
  };
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, "merchants/limit-increase-requests", { method: "POST", body: JSON.stringify(body) });
    if (r?.state === "ok" && r?.result?.pay_url) return res.json({ pay_url: r.result.pay_url, fee: r.result.fee, reference_id: r.result.reference_id });
    res.status(422).json({ error: typeof r?.result === "string" ? r.result : "Could not create request" });
  } catch (err) { res.status(502).json({ error: err?.message || "request_failed" }); }
});

// Confirm a returned payment → activates the time-bound override.
app.post("/api/confirm", core.requireSession, express.json(), async (req, res) => {
  const reference_id = req.body?.reference_id;
  if (!reference_id) return res.status(400).json({ error: "reference_id required" });
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, "merchants/limit-increase-requests/confirm", { method: "POST", body: JSON.stringify({ reference_id }) });
    if (r?.state === "ok") return res.json({ ok: true, result: r.result });
    res.status(422).json({ error: typeof r?.result === "string" ? r.result : "Could not confirm" });
  } catch (err) { res.status(502).json({ error: err?.message || "confirm_failed" }); }
});

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[limit-increase] listening on ${HOST}:${PORT}`));
