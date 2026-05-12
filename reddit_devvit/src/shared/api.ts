export type JoinTokenResponse =
  | { ok: true; url: string }
  | { ok: false; reason: 'not_configured' | 'not_logged_in' | 'sign_failed' };
