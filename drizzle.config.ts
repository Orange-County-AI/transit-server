import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: ["./src/db/schema.ts", "./src/db/app-schema.ts"],
  dialect: "sqlite",
  driver: "d1-http",
});
