import { Request, Response, NextFunction } from "express";
import { getAdminClient } from "../lib/supabase";
import { sendError } from "../lib/http";
import { logger } from "../lib/logger";
import { syncProfileEmail } from "../lib/userLookup";
import { isApiKeyToken } from "../core/apiKeys";
import {
  authenticateApiKey,
  touchApiKeyLastUsed,
  type ApiKeyScope,
} from "../lib/apiKeys";

/**
 * The /user/profile (and /users/profile alias) endpoint must stay reachable
 * even before a second factor is verified, otherwise the client cannot learn
 * that MFA is required or render the verification gate. Treat it as the MFA
 * bootstrap route.
 */
function isLoginMfaBootstrapRoute(req: Request): boolean {
  const path = req.originalUrl.split("?")[0];
  return (
    (req.method === "GET" || req.method === "POST") &&
    (path === "/user/profile" || path === "/users/profile")
  );
}

/**
 * When a user has opted into MFA-on-login, every authenticated request must be
 * carried by an aal2 session. Returns true when the request may proceed and
 * false when a response (401/403/500) has already been sent.
 */
async function enforceLoginMfaIfEnabled(
  req: Request,
  res: Response,
  token: string,
): Promise<boolean> {
  if (isLoginMfaBootstrapRoute(req)) return true;

  const admin = getAdminClient();
  const { data, error } = await admin
    .from("user_profiles")
    .select("mfa_on_login")
    .eq("user_id", res.locals.userId)
    .maybeSingle();

  if (error) {
    // 42703 = column does not exist (older databases without the
    // mfa_on_login column): fail open so the app keeps working.
    if (error.code === "42703") return true;
    logger.warn(
      { path: req.originalUrl, code: error.code },
      "MFA login preference lookup failed",
    );
    sendError(res, 500, "INTERNAL_ERROR", error.message);
    return false;
  }

  const profile = data as { mfa_on_login?: boolean } | null;
  if (profile?.mfa_on_login !== true) return true;

  const { data: assurance, error: assuranceError } =
    await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);

  if (assuranceError) {
    logger.warn(
      { path: req.originalUrl },
      "MFA login assurance lookup failed",
    );
    sendError(res, 401, "UNAUTHORIZED", assuranceError.message);
    return false;
  }

  if (assurance.nextLevel === "aal2" && assurance.currentLevel !== "aal2") {
    // Exact response shape consumed by the web client's MFA login gate.
    res.status(403).json({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    return false;
  }

  return true;
}

/**
 * Map an HTTP method to the API-key scope it requires. Safe, side-effect-free
 * verbs need only `read`; anything that can mutate state needs `write`.
 */
function requiredScopeForMethod(method: string): ApiKeyScope {
  return method === "GET" || method === "HEAD" ? "read" : "write";
}

/**
 * API-key authentication branch. Handles `Authorization: Bearer mike_sk_...`.
 * Returns true when the request is fully authenticated and may proceed to
 * `next()`, false when a 401/403 response has already been sent.
 *
 * Note: API keys deliberately bypass the interactive MFA-on-login gate. MFA
 * protects *browser sessions* (something you know + an authenticator); a
 * long-lived programmatic credential is a distinct factor (something you hold)
 * that the user explicitly minted and can revoke at any time. Forcing aal2 on
 * a headless key would make it unusable. This is documented in the ADR.
 */
async function authenticateWithApiKey(
  req: Request,
  res: Response,
  token: string,
): Promise<boolean> {
  const result = await authenticateApiKey(token);
  if (!result) {
    sendError(res, 401, "UNAUTHORIZED", "Invalid or revoked API key");
    return false;
  }

  const needed = requiredScopeForMethod(req.method);
  if (!result.scopes.includes(needed)) {
    sendError(
      res,
      403,
      "FORBIDDEN",
      `This API key is missing the '${needed}' scope required for ${req.method} requests`,
    );
    return false;
  }

  res.locals.userId = result.userId;
  res.locals.apiKeyId = result.keyId;
  res.locals.authMethod = "api_key";

  // Downstream routes (project sharing, exports) key off the caller's email.
  // Resolve it from the user record so API-key callers behave like JWT callers.
  const { data: userData } = await getAdminClient().auth.admin.getUserById(
    result.userId,
  );
  res.locals.userEmail = userData?.user?.email?.toLowerCase() ?? "";

  // Best-effort, non-blocking usage tracking — never delays the request.
  void touchApiKeyLastUsed(result.keyId);
  return true;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    sendError(res, 401, "UNAUTHORIZED", "Missing or invalid Authorization header");
    return;
  }
  const token = auth.slice(7).trim();

  // Branch on the credential type. Programmatic API keys are self-describing
  // (`mike_sk_` prefix); anything else is treated as a Supabase JWT, preserving
  // the original behaviour byte-for-byte.
  if (isApiKeyToken(token)) {
    if (await authenticateWithApiKey(req, res, token)) next();
    return;
  }

  const { data } = await getAdminClient().auth.getUser(token);
  if (!data.user) {
    sendError(res, 401, "UNAUTHORIZED", "Invalid or expired token");
    return;
  }

  res.locals.userId = data.user.id;
  res.locals.userEmail = data.user.email?.toLowerCase() ?? "";
  res.locals.token = token;

  const syncError = await syncProfileEmail(
    getAdminClient(),
    data.user.id,
    data.user.email,
  );
  if (syncError) {
    logger.warn(
      {
        method: req.method,
        path: req.originalUrl,
        userId: data.user.id,
        error: syncError.message,
      },
      "Profile email sync failed",
    );
  }

  if (!(await enforceLoginMfaIfEnabled(req, res, token))) {
    return;
  }
  next();
}

/**
 * Route-level guard for sensitive actions (changing security settings,
 * exporting or deleting account data). When the caller has a verified TOTP
 * factor enrolled, the current session must be aal2.
 */
export async function requireMfaIfEnrolled(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = typeof res.locals.token === "string" ? res.locals.token : "";
  if (!token) {
    sendError(res, 401, "UNAUTHORIZED", "Missing auth session");
    return;
  }

  const admin = getAdminClient();
  const { data, error } =
    await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);

  if (error) {
    logger.warn({ path: req.originalUrl }, "MFA assurance lookup failed");
    sendError(res, 401, "UNAUTHORIZED", error.message);
    return;
  }

  if (data.nextLevel === "aal2" && data.currentLevel !== "aal2") {
    // Exact response shape consumed by the web client's MFA verification flow.
    res.status(403).json({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    return;
  }

  next();
}

/**
 * Guard for management routes that must be driven by a real, interactive user
 * session — never by a programmatic API key. This is what stops a key from
 * minting *more* keys (privilege escalation) or editing webhook endpoints.
 *
 * Mount it AFTER `requireAuth`, which has already populated `res.locals`.
 */
export function requireUserSession(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.locals.authMethod === "api_key") {
    sendError(
      res,
      403,
      "FORBIDDEN",
      "This endpoint requires a logged-in user session and cannot be used with an API key",
    );
    return;
  }
  next();
}
