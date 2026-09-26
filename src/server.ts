import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSilenceServer } from "./api/http-server.ts";
import { createFairLaunchCreateAdapter } from "./api/fair-launch-create.ts";

export { createSilenceServer } from "./api/http-server.ts";
export type * from "./api/http-server.ts";

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(resolve(entry)).href === import.meta.url);
}

if (isDirectExecution()) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    process.exitCode = 1;
  } else {
    const fairLaunchCreateAdapter = process.env.FAIR_LAUNCH_CREATE_ENABLED === "1"
      ? createFairLaunchCreateAdapter()
      : undefined;
    const server = createSilenceServer({ fairLaunchCreateAdapter });
    server.once("error", () => {
      process.exitCode = 1;
    });
    server.listen(port, host);
  }
}
