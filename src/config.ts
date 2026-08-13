import { loadAllProfiles } from "./config/load.js";

/**
 * Back-compat shim over `src/config/{schema,validate,load}.ts`.
 *
 * Every existing import (`import { config, assertConfigValid } from "./config.js"`)
 * keeps working unchanged. This is the local, all-in-one path — it validates against
 * *both* the resource and chat profiles combined, same as the original single-file
 * config did, since `src/index.ts` (which is what actually uses this shim) still runs
 * everything in one process. The containerized services (`src/services/resource.ts`,
 * `src/services/chat.ts`) call `loadConfig`/`assertConfigValid` from `./config/load.js`
 * directly instead, scoped to just their own profile.
 */

const { config, assertAll } = loadAllProfiles();

export { config };

export function assertConfigValid(): void {
  assertAll();
}
