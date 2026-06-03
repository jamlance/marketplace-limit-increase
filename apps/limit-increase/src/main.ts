import "./index.css";
import {
  initBv, makeToast, bvApi, type BvToastFn,
  mountShell, statRow, dataTable, card, emptyState, pill, flash, h, icon, skeleton,
} from "./bv-init";

interface Limits {
  daily_limit?: number; monthly_limit?: number; single_limit?: number; withdrawal_limit?: number;
  usage_today?: number; usage_month?: number;
  active_overrides?: { limit_kind: string; amount: number; expires_in_seconds: number }[];
}
interface HistoryRow {
  id: number; limit_kind?: string; amount: number; duration_days?: number; fee?: number;
  reason?: string; reference?: string; status: string; expires_at?: string; created_at?: string;
}

const root = document.getElementById("root")!;
let toast: BvToastFn;
let currency = "JMD";
let limits: Limits = {};
let shell: ReturnType<typeof mountShell>;

const RATE = 0.05, MIN_FEE = 250, VELOCITY_DAY_FEE = 150, MAX_VELOCITY = 50;
const KIND_OPTS: [string, string][] = [
  ["daily", "Daily limit"],
  ["single", "Per-transaction limit"],
  ["monthly", "Monthly limit"],
  ["velocity", "Event velocity (per-min)"],
];
// Map API status keys to pill tones — "pending" uses "warning" to match the CSS selector
const HIST_TONE: Record<string, string> = {
  approved: "ok",
  active: "ok",
  pending: "warning",
  expired: "",
  rejected: "bad",
};

(async () => {
  const params = new URLSearchParams(location.search);
  const hasSession = params.has("inkress_session");
  const confirmRef = params.get("confirm_limit");
  const isDev = import.meta.env.DEV && !hasSession;

  // Payment-return landing. The hosted checkout redirects the *new tab* back here
  // with no embedded session. Render a friendly "you can close this tab" page;
  // the still-open embedded app confirms and activates via its own poll.
  if (!isDev && !hasSession && confirmRef) { renderReturnLanding(); return; }

  let session;
  if (isDev) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  currency = session.merchant.currency_code || "JMD";

  // If reopened embedded with a confirm token, activate immediately.
  if (confirmRef && hasSession) {
    await tryConfirm(confirmRef, true);
    history.replaceState(null, "", location.pathname);
  }

  shell = mountShell({
    brandIcon: "sparkles", brandLogo: "/logo.svg",
    title: "Limit Increase",
    subtitle: `${session.merchant.name || "Merchant"} · temporary headroom when you need it`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "increase", label: "Request increase", icon: "sparkles", render },
      { id: "history", label: "History", icon: "clock", render: renderHistory },
    ],
  });
})();

const money = (n?: number) => {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n || 0); }
  catch { return `${currency} ${Math.round(n || 0)}`; }
};
const dateStr = (s?: string) => (s ? new Date(s).toLocaleDateString() : "—");
const feeFor = (amount: number, duration: number) =>
  Math.max(MIN_FEE, Math.round(amount * RATE * (duration / 30) * 100) / 100);

async function tryConfirm(ref: string, notify: boolean): Promise<boolean> {
  const r = await bvApi<{ ok?: boolean; error?: string }>(
    "/api/confirm",
    { method: "POST", body: JSON.stringify({ reference_id: ref }) },
  ).catch((e: any): { ok?: boolean; error?: string } => ({ error: e?.message }));
  if (r?.ok) { if (notify) flash("Limit increase activated", "success"); return true; }
  if (notify) flash(r?.error || "Couldn't confirm the increase", "error");
  return false;
}

// ─── Loading skeleton ─────────────────────────────────────────────

function renderLoadingSkeleton(host: HTMLElement) {
  const statSkel = h("div", { class: "li-skeleton-stats" },
    ...([1, 2, 3] as const).map(() =>
      h("div", { class: "li-skeleton-stat" },
        skeleton("40%", 10),
        skeleton("60%", 20),
        skeleton("50%", 10),
      )
    )
  );
  const cardSkel = h("div", { class: "bv-card", style: { marginTop: "16px" } },
    skeleton("30%", 14),
    h("div", { style: { marginTop: "16px" } }),
    skeleton("100%", 38),
    h("div", { style: { marginTop: "12px" } }),
    skeleton("100%", 38),
    h("div", { style: { marginTop: "12px" } }),
    skeleton("70%", 38),
  );
  host.append(statSkel, cardSkel);
}

// ─── Main "Request increase" tab ─────────────────────────────────

async function render(host: HTMLElement) {
  renderLoadingSkeleton(host);

  const s = await bvApi<{ limits: Limits; available: boolean }>("/api/state").catch(() => null);
  host.innerHTML = "";

  if (!s) {
    host.append(card({
      body: h("div", { class: "li-error" },
        h("div", { class: "li-error-icon", html: icon("alert", 24) }),
        h("h3", null, "Couldn't load your limits"),
        h("p", null, "Check your connection and try again shortly."),
        h("button", { class: "secondary", onClick: () => { host.innerHTML = ""; render(host); } }, "Retry"),
      ),
    }));
    return;
  }

  limits = s.limits || {};

  host.append(statRow([
    {
      k: "Daily limit",
      v: money(limits.daily_limit),
      d: `${money(limits.usage_today)} used today`,
      icon: "wallet",
      tone: "accent",
    },
    {
      k: "Per transaction",
      v: money(limits.single_limit),
      icon: "tag",
    },
    {
      k: "Monthly limit",
      v: money(limits.monthly_limit),
      d: `${money(limits.usage_month)} used`,
      icon: "calendar",
    },
  ]));

  const overs = limits.active_overrides || [];
  if (overs.length) {
    host.append(card({
      title: "Active increases",
      body: h("ul", { class: "li-overrides" },
        ...overs.map((o) =>
          h("li", null,
            h("div", { class: "li-override-row" },
              h("div", { class: "li-override-left" },
                pill(
                  o.limit_kind === "velocity"
                    ? `+${o.amount}/min · ${labelKind(o.limit_kind)}`
                    : `+${money(o.amount)} ${labelKind(o.limit_kind)}`,
                  "ok",
                  "sparkles",
                ),
              ),
              h("span", { class: "li-override-time" }, fmtRemaining(o.expires_in_seconds) + " left"),
            )
          )
        )
      ),
    }));
  }

  host.append(card({
    title: "Request a temporary increase",
    body: requestForm(),
  }));
}

// ─── Request form ─────────────────────────────────────────────────

function requestForm(): HTMLElement {
  const kindEl = h("select", { class: "li-input" },
    ...KIND_OPTS.map(([v, l]) => h("option", { value: v }, l)),
  ) as HTMLSelectElement;

  const amountEl = h("input", {
    class: "li-input",
    type: "number",
    min: "1",
    step: "100",
    placeholder: "Extra headroom amount",
  }) as HTMLInputElement;

  const durationEl = h("input", {
    class: "li-input",
    type: "number",
    min: "1",
    max: "90",
    value: "7",
  }) as HTMLInputElement;

  const reasonEl = h("textarea", {
    class: "li-input",
    rows: "3",
    placeholder: "e.g. ticket sale launch, promo event this weekend",
  }) as HTMLTextAreaElement;

  const proofEl = h("input", {
    class: "li-input",
    type: "text",
    placeholder: "Link or note (optional)",
  }) as HTMLInputElement;

  // Fee breakdown elements
  const feeRowUnlock = h("div", { class: "li-fee-row" },
    h("span", { class: "li-fee-label" }, "Unlocks"),
    h("span", { class: "li-fee-value", id: "li-fee-unlock" }, "—"),
  );
  const feeRowDuration = h("div", { class: "li-fee-row" },
    h("span", { class: "li-fee-label" }, "For"),
    h("span", { class: "li-fee-value", id: "li-fee-duration" }, "—"),
  );
  const feeDivider = h("div", { class: "li-fee-divider is-empty" });
  const feeRowTotal = h("div", { class: "li-fee-row" },
    h("span", { class: "li-fee-total-label" }, "One-time fee"),
    h("span", { class: "li-fee-total-value", id: "li-fee-total" }, "—"),
  );
  const feePlaceholder = h("div", { class: "li-fee-placeholder" }, "Enter amount and duration to see the fee");

  const feeBox = h("div", { class: "li-fee-box is-empty" },
    feePlaceholder,
    feeRowUnlock,
    feeRowDuration,
    feeDivider,
    feeRowTotal,
  );
  // Initially show placeholder only
  feeRowUnlock.hidden = true;
  feeRowDuration.hidden = true;
  feeDivider.hidden = true;
  feeRowTotal.hidden = true;

  const modeBadge = h("span", { class: "li-mode-badge is-money" }, "Amount increase");
  const amountLabel = h("span", { class: "li-label" }, "Increase by");
  const amountHint = h("span", { class: "li-hint" }, "How much extra headroom to add to this limit");
  const durationLabel = h("span", { class: "li-label" }, "Duration (days)");
  const durationHint = h("span", { class: "li-hint" }, "1–90 days; fee is prorated to this window");

  const submit = h("button", { class: "primary li-submit" }, "Pay & activate") as HTMLButtonElement;

  const wrap = h("div", { class: "li-form" },
    // Mode badge
    h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
      h("span", { class: "li-label" }, "Type"),
      modeBadge,
    ),
    field(h("span", { class: "li-label" }, "Which limit"), kindEl),
    h("div", { class: "li-form-row" },
      fieldWithHint(amountLabel, amountHint, amountEl),
      fieldWithHint(durationLabel, durationHint, durationEl),
    ),
    field(h("span", { class: "li-label" }, "Reason"), reasonEl,
      h("span", { class: "li-hint" }, "Required — helps the review go faster")),
    field(h("span", { class: "li-label" }, "Proof (optional)"), proofEl),
    feeBox,
    h("div", { class: "li-foot" }, submit),
  );

  const isVel = () => kindEl.value === "velocity";
  const feeCalc = (a: number, d: number) =>
    isVel()
      ? Math.max(MIN_FEE, Math.round(d * VELOCITY_DAY_FEE * 100) / 100)
      : feeFor(a, d);

  const relabel = () => {
    const vel = isVel();
    amountEl.placeholder = vel ? "Extra attempts per minute (max 50)" : "Extra headroom amount";
    amountEl.max = vel ? String(MAX_VELOCITY) : "";
    amountEl.step = vel ? "1" : "100";
    amountLabel.textContent = vel ? "Extra attempts / min" : "Increase by";
    amountHint.textContent = vel
      ? `Max ${MAX_VELOCITY}/min; charged a flat per-day fee`
      : "How much extra headroom to add to this limit";
    durationHint.textContent = vel
      ? "Event window in days; flat fee per day"
      : "1–90 days; fee is prorated to this window";
    modeBadge.className = vel ? "li-mode-badge is-velocity" : "li-mode-badge is-money";
    modeBadge.textContent = vel ? "Velocity boost" : "Amount increase";
  };

  const recalc = () => {
    const a = Number(amountEl.value) || 0;
    const d = Number(durationEl.value) || 0;
    const vel = isVel();

    if (a <= 0 || d <= 0) {
      // Show placeholder, hide rows
      feePlaceholder.hidden = false;
      feeRowUnlock.hidden = true;
      feeRowDuration.hidden = true;
      feeDivider.hidden = true;
      feeRowTotal.hidden = true;
      feeBox.classList.add("is-empty");
      feeDivider.classList.add("is-empty");
      feePlaceholder.textContent = vel
        ? "Set attempts/min and event duration to see the fee"
        : "Enter an amount and duration to see the fee";
      return;
    }

    const fee = feeCalc(a, d);
    const unlockText = vel ? `+${a}/min on event velocity` : `+${money(a)} to ${labelKind(kindEl.value)}`;
    const durationText = `${d} day${d === 1 ? "" : "s"}`;

    (feeBox.querySelector("#li-fee-unlock") as HTMLElement).textContent = unlockText;
    (feeBox.querySelector("#li-fee-duration") as HTMLElement).textContent = durationText;
    (feeBox.querySelector("#li-fee-total") as HTMLElement).textContent = money(fee);

    feePlaceholder.hidden = true;
    feeRowUnlock.hidden = false;
    feeRowDuration.hidden = false;
    feeDivider.hidden = false;
    feeRowTotal.hidden = false;
    feeBox.classList.remove("is-empty");
    feeDivider.classList.remove("is-empty");
  };

  kindEl.addEventListener("change", () => { relabel(); recalc(); });
  amountEl.addEventListener("input", recalc);
  durationEl.addEventListener("input", recalc);
  relabel();
  recalc();

  submit.addEventListener("click", async () => {
    const a = Number(amountEl.value) || 0;
    const d = Number(durationEl.value) || 0;
    if (a <= 0) return flash("Enter an increase amount", "warning");
    if (isVel() && a > MAX_VELOCITY) return flash(`Velocity boost is capped at ${MAX_VELOCITY}/min`, "warning");
    if (d < 1 || d > 90) return flash("Duration must be 1–90 days", "warning");
    if (!reasonEl.value.trim()) return flash("A reason is required", "warning");

    // Open the checkout tab synchronously (within the click gesture) so popup
    // blockers allow it; navigate it once the pay link is ready.
    const win = window.open("", "_blank");
    submit.disabled = true;
    submit.textContent = "Starting checkout…";

    type ReqResp = { pay_url?: string; reference_id?: string; fee?: number; error?: string };
    const r = await bvApi<ReqResp>("/api/request", {
      method: "POST",
      body: JSON.stringify({
        limit_kind: kindEl.value,
        amount: a,
        duration_days: d,
        reason: reasonEl.value.trim(),
        proof: proofEl.value.trim(),
      }),
    }).catch((e: any): ReqResp => ({ error: e?.message }));

    submit.disabled = false;
    submit.textContent = "Pay & activate";

    if (r?.pay_url && r.reference_id) {
      if (win) { try { win.location.href = r.pay_url; } catch { /* blocked */ } }
      showCheckout(wrap, r.pay_url, r.reference_id, r.fee, !win);
      return;
    }
    if (win) win.close();
    flash(r?.error || "Couldn't start the request", "error");
  });

  return wrap;
}

// ─── Checkout / payment waiting panel ─────────────────────────────

function showCheckout(
  formEl: HTMLElement,
  payUrl: string,
  ref: string,
  fee: number | undefined,
  popupBlocked: boolean,
) {
  const statusEl = h("div", { class: "li-checkout-status" },
    h("div", { class: "li-poll-dot" }),
    h("span", null, "Waiting for payment confirmation…"),
  );

  const openBtn = h("a", {
    class: "primary",
    href: payUrl,
    target: "_blank",
    rel: "noopener",
  },
    h("span", { html: icon("external-link", 16), style: { display: "inline-grid", placeItems: "center" } }),
    popupBlocked ? "Open secure checkout" : "Open checkout again",
  );

  const checkBtn = h("button", { class: "secondary" }, "I've completed payment") as HTMLButtonElement;
  const restart = h("button", { class: "ghost" }, "Start over") as HTMLButtonElement;

  let stopped = false;

  const finish = () => {
    stopped = true;
    statusEl.className = "li-checkout-status is-success";
    statusEl.innerHTML = "";
    statusEl.append(
      h("span", { html: icon("check", 16), style: { display: "inline-grid", placeItems: "center" } }),
      h("span", null, "Limit increase activated successfully"),
    );
    flash("Limit increase activated", "success");
    // Refresh the tab after a short moment so the new limits are shown
    setTimeout(() => shell.select("increase"), 1400);
  };

  const checkOnce = async (notify: boolean) => {
    if (stopped) return false;
    const ok = await tryConfirm(ref, notify && false);
    if (ok) finish();
    return ok;
  };

  checkBtn.addEventListener("click", async () => {
    checkBtn.disabled = true;
    checkBtn.textContent = "Checking…";
    const ok = await checkOnce(true);
    checkBtn.disabled = false;
    checkBtn.textContent = "I've completed payment";
    if (!ok) {
      statusEl.querySelector("span:last-child")!.textContent =
        "Payment not detected yet — finish the checkout, then check again.";
    }
  });

  restart.addEventListener("click", () => { stopped = true; shell.select("increase"); });

  // Auto-poll for ~3 minutes (36 × 5 s).
  let tries = 0;
  const tick = async () => {
    if (stopped) return;
    tries++;
    const ok = await checkOnce(false);
    if (ok || stopped) return;
    if (tries >= 36) {
      statusEl.querySelector("span:last-child")!.textContent =
        "Still waiting — once you've paid, tap \"I've completed payment\".";
      return;
    }
    setTimeout(tick, 5000);
  };
  setTimeout(tick, 5000);

  const feeDesc = fee != null ? `The ${money(fee)} fee ` : "Your fee ";

  formEl.replaceChildren(
    h("div", { class: "li-checkout" },
      h("div", { class: "li-checkout-header" },
        h("div", { class: "li-checkout-icon", html: icon("lock", 22) }),
        h("div", { class: "li-checkout-meta" },
          h("h3", null, "Complete your payment"),
          h("p", null,
            feeDesc + "secures the temporary increase. " +
            (popupBlocked
              ? "The checkout window was blocked — use the button below to open it."
              : "Complete the payment in the new tab — your limit activates automatically here.")
          ),
        ),
      ),
      statusEl,
      h("div", { class: "li-checkout-actions" }, openBtn),
      h("div", { class: "li-checkout-secondary" },
        checkBtn,
        restart,
      ),
    )
  );
}

// ─── Payment-return landing ────────────────────────────────────────

function renderReturnLanding() {
  root.innerHTML = "";
  root.className = "li-return";
  root.append(
    h("div", { class: "li-return-card" },
      h("div", { class: "li-return-check", html: icon("check", 26) }),
      h("h2", null, "Payment received"),
      h("p", null,
        "Your limit increase is being activated. Return to the Limit Increase app in your Inkress dashboard — your new headroom will appear there in a moment.",
      ),
      h("button", {
        class: "primary",
        style: { width: "100%", minHeight: "42px" },
        onClick: () => { try { window.close(); } catch { /* ignore */ } },
      }, "Close this tab"),
      h("div", { class: "li-return-foot" }, "Powered by Marketplace"),
    )
  );
}

// ─── History tab ──────────────────────────────────────────────────

async function renderHistory(host: HTMLElement) {
  // Skeleton placeholder
  host.append(
    h("div", { class: "bv-card" },
      skeleton("30%", 14),
      h("div", { style: { marginTop: "16px" } }),
      ...([1, 2, 3] as const).map(() =>
        h("div", { style: { marginBottom: "12px" } },
          skeleton("100%", 14),
        )
      ),
    )
  );

  const r = await bvApi<{ requests: HistoryRow[] }>("/api/history").catch(() => ({ requests: [] }));
  host.innerHTML = "";
  const rows = r?.requests || [];

  host.append(card({
    title: "Request & approval history",
    body: dataTable<HistoryRow>({
      columns: [
        { head: "Limit", cell: (x) => x.limit_kind ? labelKind(x.limit_kind) : "—" },
        {
          head: "Increase",
          num: true,
          cell: (x) =>
            x.limit_kind === "velocity" ? `+${x.amount}/min` : `+${money(x.amount)}`,
        },
        { head: "Days", num: true, cell: (x) => x.duration_days != null ? String(x.duration_days) : "—" },
        { head: "Fee", num: true, cell: (x) => x.fee != null ? money(x.fee) : "—" },
        {
          head: "Status",
          cell: (x) => pill(
            x.status.charAt(0).toUpperCase() + x.status.slice(1),
            HIST_TONE[x.status] ?? "",
          ),
        },
        { head: "Requested", cell: (x) => dateStr(x.created_at) },
        { head: "Expires", cell: (x) => dateStr(x.expires_at) },
      ],
      rows,
      empty: emptyState({
        icon: "clock",
        title: "No requests yet",
        text: "Your limit-increase requests and approvals will appear here.",
      }),
    }),
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────

function labelKind(k: string): string {
  return ({
    daily: "Daily",
    single: "Per-transaction",
    monthly: "Monthly",
    velocity: "Event velocity",
  } as Record<string, string>)[k] || k;
}

function field(label: Node, input: Node, hint?: Node): HTMLElement {
  return h("label", { class: "li-field" }, label, input, ...(hint ? [hint] : []));
}

function fieldWithHint(label: Node, hint: Node, input: Node): HTMLElement {
  return h("label", { class: "li-field" }, label, input, hint);
}

function fmtRemaining(sec: number): string {
  if (sec <= 0) return "expiring";
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600);
  return d >= 1 ? `${d}d ${hr}h` : `${hr}h`;
}

function fatal(msg?: string): HTMLElement {
  return h("div", { class: "bv-card", style: { margin: "24px" } },
    h("h2", null, "Couldn't start"),
    h("p", { class: "bv-muted" }, msg || "Unable to initialize."),
  );
}
