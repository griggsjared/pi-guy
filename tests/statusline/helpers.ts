import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerStatusline } from "../../src/statusline/footer.ts";
import providerUsage from "../../src/statusline/index.ts";
import { captureHandlers } from "../helpers/pi.ts";
import { fakeTheme } from "../helpers/theme.ts";

export function mountFooter(context: any, statuses: Map<string, string>) {
  const { handlers, on } = captureHandlers();
  let footer: any;
  context.ui = {
    setFooter: (callback: any) => {
      footer = callback;
    },
  };
  registerStatusline({ on } as unknown as ExtensionAPI);
  handlers.get("session_start")?.[0]?.({}, context);
  return footer({ invalidate() {} }, fakeTheme(), { getExtensionStatuses: () => statuses });
}

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
