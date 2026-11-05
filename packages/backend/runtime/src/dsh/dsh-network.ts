import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/** Install the parent's proxy in the DSH process before its first model call. */
export function configureDshNetwork(
  env: NodeJS.ProcessEnv = process.env,
  install: (agent: EnvHttpProxyAgent) => void = setGlobalDispatcher,
): boolean {
  const allProxy = env.ALL_PROXY?.trim();
  const httpProxy = env.HTTP_PROXY?.trim() || allProxy;
  const httpsProxy = env.HTTPS_PROXY?.trim() || allProxy || httpProxy;
  if (!httpProxy && !httpsProxy) return false;
  install(
    new EnvHttpProxyAgent({
      httpProxy,
      httpsProxy,
      noProxy: env.NO_PROXY || "127.0.0.1,localhost,[::1]",
    }),
  );
  return true;
}
