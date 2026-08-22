/**
 * Transactional email for the password-reset flow.
 *
 * Delivery rides Cloudflare's native Email Sending binding (`env.EMAIL`,
 * declared as `send_email` in wrangler.jsonc) — no third-party API keys. The
 * `EMAIL_FROM` address's domain must be onboarded onto Cloudflare Email
 * Sending first (dashboard: Compute > Email Service > Email Sending > Onboard
 * Domain, or `wrangler email sending enable <domain>`); until then sends fail
 * with `E_SENDER_NOT_VERIFIED`.
 *
 * Under vitest, miniflare supplies a local `send_email` stub that captures the
 * message instead of delivering it, so the full build-and-send path runs in
 * tests. The `!env.EMAIL` guard is defensive for any environment where the
 * binding isn't declared at all — it degrades to a warning rather than
 * throwing. A present-but-failing send still throws, so Better Auth logs real
 * delivery failures.
 */
const DEFAULT_FROM = "noreply@mail.orangecountyai.com";

type ResetEmailInput = {
  to: string;
  /** Better Auth's reset link: GET .../reset-password/:token?callbackURL=... */
  url: string;
  /** Recipient's display name, for a friendlier greeting. */
  name?: string;
};

export async function sendPasswordResetEmail(
  env: Env,
  { to, url, name }: ResetEmailInput,
): Promise<void> {
  if (!env.EMAIL) {
    console.warn(
      "[email] EMAIL binding unavailable — skipping password-reset send. " +
        "Configure the `send_email` binding to deliver reset links.",
    );
    return;
  }

  const greeting = name ? `Hi ${name},` : "Hi,";

  await env.EMAIL.send({
    to,
    from: { email: env.EMAIL_FROM || DEFAULT_FROM, name: "Transit" },
    subject: "Reset your Transit password",
    text: [
      greeting,
      "",
      "We received a request to reset your Transit password. Open the",
      "link below to choose a new one. The link expires in 1 hour.",
      "",
      url,
      "",
      "If you didn't request this, you can safely ignore this email — your",
      "password won't change.",
    ].join("\n"),
    html: resetHtml({ greeting, url }),
  });
}

function resetHtml({ greeting, url }: { greeting: string; url: string }): string {
  return `<!doctype html>
<html>
  <body style="margin:0;background:#0b0b0c;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8e8ea;">
    <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
      <h1 style="font-size:20px;font-weight:600;margin:0 0 16px;">Reset your password</h1>
      <p style="font-size:14px;line-height:1.6;color:#b8b8bd;margin:0 0 16px;">${greeting}</p>
      <p style="font-size:14px;line-height:1.6;color:#b8b8bd;margin:0 0 24px;">
        We received a request to reset your Transit password. Click the
        button below to choose a new one. This link expires in 1 hour.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${url}" style="display:inline-block;background:#ff6a1a;color:#0b0b0c;font-weight:600;font-size:14px;text-decoration:none;padding:12px 20px;">
          Reset password
        </a>
      </p>
      <p style="font-size:12px;line-height:1.6;color:#7a7a80;margin:0 0 8px;">
        Or paste this link into your browser:
      </p>
      <p style="font-size:12px;line-height:1.6;word-break:break-all;margin:0 0 24px;">
        <a href="${url}" style="color:#ff6a1a;">${url}</a>
      </p>
      <p style="font-size:12px;line-height:1.6;color:#7a7a80;margin:0;">
        If you didn't request this, you can safely ignore this email — your
        password won't change.
      </p>
    </div>
  </body>
</html>`;
}
