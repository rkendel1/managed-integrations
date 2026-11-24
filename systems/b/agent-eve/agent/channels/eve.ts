import { eveChannel } from "eve/channels/eve";
import { httpBasic } from "eve/channels/auth";

// Only System B's runtime may call this agent (credentials from FeltKit custody on B's side).
export default eveChannel({
  auth: [
    httpBasic({ username: process.env.MI_REPAIR_AGENT_USER ?? "system-b", password: process.env.MI_REPAIR_AGENT_PASSWORD ?? "" }),
  ],
});
