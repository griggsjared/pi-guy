import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import providerUsage from "../../src/provider-usage/index.ts";
import { captureHandlers } from "../helpers/pi.ts";

export function mountProviderUsage() {
  const { handlers, on } = captureHandlers();
  providerUsage({
    events: {
      on() {
        return () => {};
      },
      emit() {},
    },
    on,
  } as unknown as ExtensionAPI);
  return handlers;
}
