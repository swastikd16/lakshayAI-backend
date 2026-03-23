export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "admin";
export const ADMIN_ACCESS_TOKEN = "lakshay-admin-dev-token";
export const ADMIN_USER_ID = "00000000-0000-0000-0000-000000000001";
export const ADMIN_EMAIL = "admin@lakshay.local";

export function isAdminCredential(emailOrUsername: string, password: string) {
  return emailOrUsername.trim().toLowerCase() === ADMIN_USERNAME && password === ADMIN_PASSWORD;
}
