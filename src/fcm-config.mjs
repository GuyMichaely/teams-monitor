import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { LOCAL_HOME } from "./local-paths.mjs";

export const DEFAULT_FCM_SERVICE_ACCOUNT_FILE = "config/fcm-service-account.json";

export async function resolveFcmConfig(fcm = {}) {
  const serviceAccountFile = String(
    fcm.serviceAccountFile || DEFAULT_FCM_SERVICE_ACCOUNT_FILE
  ).trim() || DEFAULT_FCM_SERVICE_ACCOUNT_FILE;
  const serviceAccountPath = isAbsolute(serviceAccountFile)
    ? serviceAccountFile
    : join(LOCAL_HOME, serviceAccountFile);

  let serviceAccount = null;
  let serviceAccountPresent = false;
  let serviceAccountError = null;
  try {
    const raw = await readFile(serviceAccountPath, "utf8");
    serviceAccountPresent = true;
    serviceAccount = JSON.parse(raw);
  } catch (error) {
    serviceAccountPresent = error?.code !== "ENOENT";
    serviceAccountError = error;
  }

  const projectId = String(serviceAccount?.project_id || "").trim();

  return {
    projectId,
    serviceAccountFile,
    serviceAccountPath,
    serviceAccount,
    serviceAccountPresent,
    serviceAccountValid: !!serviceAccount,
    serviceAccountError,
  };
}
