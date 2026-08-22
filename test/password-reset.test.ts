/**
 * End-to-end password-reset flow against the Hono worker via SELF.fetch().
 *
 * Exercises the full Better Auth forgot-password path:
 *   sign-up → request-password-reset → reset-password → sign-in (new pw).
 *
 * The reset link is delivered by `sendResetPassword`
 * (src/lib/email/reset-password.ts) over the Cloudflare Email binding; under
 * vitest, miniflare's local `send_email` stub captures the message rather than
 * delivering it. Rather than parse that stub, the test pulls the reset token
 * straight from the `verification` table (where Better Auth persists it as
 * `reset-password:<token>`), which is exactly the value the email link carries.
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

const ORIGIN = "http://localhost";

const cookiesFrom = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

const post = (path: string, body: unknown, cookie?: string): Promise<Response> =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })

const creds = {
  email: "reset-user@test.example",
  password: "original-pw-1!",
  name: "Reset User",
} as const

/** Pull the most recent reset token Better Auth stashed for this email. */
async function latestResetToken(): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT identifier FROM verification
       WHERE identifier LIKE 'reset-password:%'
       ORDER BY created_at DESC
       LIMIT 1`,
  ).first<{ identifier: string }>()
  if (!row) throw new Error("no reset-password verification row found")
  return row.identifier.slice("reset-password:".length)
}

describe("password reset flow", () => {
  test("a user can reset their password and sign in with the new one", async () => {
    const signUp = await post("/api/auth/sign-up/email", creds)
    expect(signUp.status, `sign-up failed: ${await signUp.clone().text()}`).toBe(200)

    // Request a reset. Better Auth answers 200 with a generic message whether
    // or not the address exists, and persists a token for real users.
    const requested = await post("/api/auth/request-password-reset", {
      email: creds.email,
      redirectTo: "/reset-password",
    })
    expect(
      requested.status,
      `request-password-reset failed: ${await requested.clone().text()}`,
    ).toBe(200)

    const token = await latestResetToken()
    const newPassword = "brand-new-pw-2!"

    const reset = await post("/api/auth/reset-password", {
      newPassword,
      token,
    })
    expect(reset.status, `reset-password failed: ${await reset.clone().text()}`).toBe(200)

    // New password works...
    const signInNew = await post("/api/auth/sign-in/email", {
      email: creds.email,
      password: newPassword,
    })
    expect(
      signInNew.status,
      `sign-in with new password failed: ${await signInNew.clone().text()}`,
    ).toBe(200)
    expect(cookiesFrom(signInNew)).toBeTruthy()

    // ...and the old password no longer does.
    const signInOld = await post("/api/auth/sign-in/email", {
      email: creds.email,
      password: creds.password,
    })
    expect(signInOld.status).toBe(401)
  })

  test("request-password-reset for an unknown email still returns 200", async () => {
    // Anti-enumeration: the endpoint must not reveal whether the address exists.
    const res = await post("/api/auth/request-password-reset", {
      email: "nobody@test.example",
      redirectTo: "/reset-password",
    })
    expect(res.status).toBe(200)
  })

  test("reset-password rejects an invalid token", async () => {
    const res = await post("/api/auth/reset-password", {
      newPassword: "whatever-pw-3!",
      token: "not-a-real-token",
    })
    expect(res.status).not.toBe(200)
  })
})
