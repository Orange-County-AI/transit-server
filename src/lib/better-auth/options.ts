import type { BetterAuthOptions } from "better-auth";

export const betterAuthOptions: BetterAuthOptions = {
  appName: "transit",
  basePath: "/api/auth",
  emailAndPassword: {
    enabled: true,
  },
  // Transit does not mark email/password accounts as verified today. Let an
  // authenticated owner replace that recovery address directly.
  user: {
    changeEmail: {
      enabled: true,
      updateEmailWithoutVerification: true,
    },
  },
  advanced: {
    ipAddress: {
      ipAddressHeaders: ["cf-connecting-ip"],
    },
  },
};
