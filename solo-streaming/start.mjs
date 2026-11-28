import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isWorkspace, createStreamAuthorization } from "./auth.mjs";
import { openStreamEvents } from "./events.mjs";
import { createMediaReader, encoderOrigin } from "./media.mjs";
import { createEncoderAuth, createStreamingApi } from "./server.mjs";

const encoder = encoderOrigin(process.env.PAIGE_SOLO_ENCODER_ORIGIN);
const allowWorkspaces = new Set((process.env.PAIGE_SOLO_WORKSPACES ?? "").split(","));
if (allowWorkspaces.size > 2 || ![...allowWorkspaces].every(isWorkspace)) throw new Error("Configure up to two pilot workspaces");
const auth = createStreamAuthorization({
  issuer: process.env.PAIGE_SOLO_OAUTH_ISSUER,
  resource: process.env.PAIGE_SOLO_OAUTH_RESOURCE,
  jwksUrl: process.env.PAIGE_SOLO_OAUTH_JWKS_URL,
  clientId: process.env.PAIGE_SOLO_OAUTH_CLIENT_ID,
});
const events = openStreamEvents("/recordings/solo-events.sqlite");
const local = createEncoderAuth({ events }).listen(9001, "127.0.0.1");
const hlsKey = randomBytes(32).toString("hex");
const mtx = spawn("mediamtx", ["mediamtx.yml"], {
  env: { ...process.env, MTX_HLSCDNSECRET: hlsKey },
  stdio: ["ignore", "inherit", "inherit"],
});
const media = createMediaReader(hlsKey);
const api = createStreamingApi({ auth, events, media, encoderOrigin: encoder, allowWorkspaces }).listen(8080, "0.0.0.0");
mtx.once("error", () => process.exit(1));
mtx.once("exit", () => process.exit(1));
process.on("SIGTERM", () => {
  api.close();
  local.close();
  mtx.kill("SIGTERM");
});
