// Staff sign in with a company code and a username that only has to be unique
// within their shop. Better Auth needs one unique username, so we store
// "<company code>.<username>". Company codes can't contain dots, which keeps
// the split unambiguous.

export const COMPANY_CODE_PATTERN = /^[a-z0-9]{2,16}$/;
export const USERNAME_PATTERN = /^[a-z0-9_.]{2,30}$/;
export const MAX_STORED_USERNAME_LENGTH = 16 + 1 + 30;

export function normalizeCompanyCode(code: string) {
  return code.trim().toLowerCase();
}

export function normalizeUsername(username: string) {
  return username.trim().toLowerCase();
}

export function storedUsername(companyCode: string, username: string) {
  return `${normalizeCompanyCode(companyCode)}.${normalizeUsername(username)}`;
}
