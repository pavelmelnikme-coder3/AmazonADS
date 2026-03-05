/**
 * Amazon Login with Amazon (LwA) OAuth 2.0 Service
 *
 * Flow:
 * 1. Frontend → GET /api/v1/connections/amazon/init  → redirect URL
 * 2. User → Amazon login page → grant permissions
 * 3. Amazon → GET /api/v1/connections/amazon/callback?code=...
 * 4. Backend exchanges code for tokens, encrypts, stores in DB
 *
 * Docs: https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html
 */

const axios = require("axios");
const crypto = require("crypto");
const { encrypt, decrypt } = require("../../config/encryption");
const { query, withTransaction } = require("../../db/pool");
const logger = require("../../config/logger");

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const LWA_AUTH_URL = "https://www.amazon.com/ap/oa";
const AMAZON_ADS_SCOPE = "advertising::campaign_management";

// State map for CSRF protection (in prod: use Redis with TTL)
const pendingStates = new Map();

/**
 * Generate the Amazon OAuth authorization URL.
 * The state parameter is a CSRF token tied to the user session.
 */
function buildAuthUrl(userId, orgId) {
  const state = crypto.randomBytes(24).toString("base64url");

  // Store state for verification in callback (TTL: 10 minutes)
  pendingStates.set(state, { userId, orgId, createdAt: Date.now() });
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_id: process.env.AMAZON_CLIENT_ID,
    scope: AMAZON_ADS_SCOPE,
    response_type: "code",
    redirect_uri: process.env.AMAZON_REDIRECT_URI,
    state,
  });

  return { url: `${LWA_AUTH_URL}?${params}`, state };
}

/**
 * Exchange authorization code for access + refresh tokens.
 * Returns the raw token response from Amazon.
 */
async function exchangeCodeForTokens(code) {
  const response = await axios.post(
    LWA_TOKEN_URL,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.AMAZON_REDIRECT_URI,
      client_id: process.env.AMAZON_CLIENT_ID,
      client_secret: process.env.AMAZON_CLIENT_SECRET,
    }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 10000,
    }
  );

  return response.data;
  // { access_token, refresh_token, token_type, expires_in (3600) }
}

/**
 * Refresh an expired access token using the stored refresh token.
 * Returns new access_token and expires_at.
 */
async function refreshAccessToken(connectionId) {
  const { rows } = await query(
    "SELECT refresh_token_enc FROM amazon_connections WHERE id = $1 AND status != 'revoked'",
    [connectionId]
  );

  if (!rows.length) throw new Error("Connection not found or revoked");

  const refreshToken = decrypt(rows[0].refresh_token_enc);

  let tokenData;
  try {
    const response = await axios.post(
      LWA_TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: process.env.AMAZON_CLIENT_ID,
        client_secret: process.env.AMAZON_CLIENT_SECRET,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000,
      }
    );
    tokenData = response.data;
  } catch (err) {
    const status = err.response?.status;
    const errorData = err.response?.data;

    // Token is permanently invalid
    if (status === 400 && errorData?.error === "invalid_grant") {
      await query(
        "UPDATE amazon_connections SET status = 'expired', last_error = $1, updated_at = NOW() WHERE id = $2",
        ["Refresh token revoked or expired. Re-authorization required.", connectionId]
      );
      throw Object.assign(new Error("Amazon authorization expired. Please reconnect your account."), { status: 401 });
    }

    await query(
      "UPDATE amazon_connections SET error_count = error_count + 1, last_error = $1, updated_at = NOW() WHERE id = $2",
      [err.message, connectionId]
    );
    throw err;
  }

  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

  await query(
    `UPDATE amazon_connections
     SET access_token_enc = $1, token_expires_at = $2,
         last_refresh_at = NOW(), error_count = 0, last_error = NULL,
         status = 'active', updated_at = NOW()
     WHERE id = $3`,
    [encrypt(tokenData.access_token), expiresAt, connectionId]
  );

  logger.debug("Token refreshed", { connectionId });
  return { accessToken: tokenData.access_token, expiresAt };
}

/**
 * Get a valid access token for a connection.
 * Automatically refreshes if expired or expiring within 5 minutes.
 */
async function getValidAccessToken(connectionId) {
  const { rows } = await query(
    `SELECT access_token_enc, token_expires_at, status
     FROM amazon_connections WHERE id = $1`,
    [connectionId]
  );

  if (!rows.length) throw Object.assign(new Error("Connection not found"), { status: 404 });

  const conn = rows[0];
  if (conn.status === "revoked") throw Object.assign(new Error("Connection has been revoked"), { status: 403 });

  const expiresAt = new Date(conn.token_expires_at);
  const fiveMinutes = 5 * 60 * 1000;

  // Refresh if expired or expiring soon
  if (expiresAt.getTime() - Date.now() < fiveMinutes) {
    const refreshed = await refreshAccessToken(connectionId);
    return refreshed.accessToken;
  }

  return decrypt(conn.access_token_enc);
}

/**
 * Save a new Amazon connection to the database.
 * Returns the created connection record.
 */
async function saveConnection(tokenData, userId, orgId, workspaceId) {
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

  const { rows } = await query(
    `INSERT INTO amazon_connections
       (org_id, workspace_id, access_token_enc, refresh_token_enc, token_expires_at, scopes, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
     RETURNING id, created_at`,
    [
      orgId,
      workspaceId || null,
      encrypt(tokenData.access_token),
      encrypt(tokenData.refresh_token),
      expiresAt,
      [AMAZON_ADS_SCOPE],
      userId,
    ]
  );

  logger.info("Amazon connection created", { connectionId: rows[0].id, orgId });
  return rows[0];
}

/**
 * Revoke a connection: delete tokens and mark as revoked.
 */
async function revokeConnection(connectionId, userId) {
  // Optionally: call Amazon's revoke endpoint
  // POST https://api.amazon.com/auth/o2/token (with token_type_hint=refresh_token)

  await query(
    `UPDATE amazon_connections
     SET status = 'revoked', access_token_enc = '', refresh_token_enc = '',
         updated_at = NOW()
     WHERE id = $1`,
    [connectionId]
  );

  logger.info("Amazon connection revoked", { connectionId, revokedBy: userId });
}

/**
 * Validate OAuth state parameter (CSRF protection).
 */
function validateState(state) {
  const data = pendingStates.get(state);
  if (!data) return null;

  // Check expiry (10 minutes)
  if (Date.now() - data.createdAt > 10 * 60 * 1000) {
    pendingStates.delete(state);
    return null;
  }

  pendingStates.delete(state);
  return data;
}

module.exports = {
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getValidAccessToken,
  saveConnection,
  revokeConnection,
  validateState,
};
