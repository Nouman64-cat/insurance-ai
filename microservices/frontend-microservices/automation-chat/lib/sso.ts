// Single sign-on between the portal and this app. The portal puts the signed-in user's token in an httpOnly cookie
// (see the portal's app/api/sso/session). Browsers send cookies to every port of the same host, and to every
// subdomain when SSO_COOKIE_DOMAIN is set, so this app can read it without the user signing in again.
export const SSO_COOKIE_NAME = process.env.SSO_COOKIE_NAME || "insurance_sso";
export const API_GATEWAY_INTERNAL_URL = process.env.API_GATEWAY_INTERNAL_URL || "http://api-gateway:8000";
