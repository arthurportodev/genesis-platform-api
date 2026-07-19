export enum AuthAuditEventType {
  LOGIN_SUCCEEDED = 'auth.login.succeeded',
  LOGIN_FAILED = 'auth.login.failed',
  REFRESH_SUCCEEDED = 'auth.refresh.succeeded',
  REFRESH_FAILED = 'auth.refresh.failed',
  REFRESH_REUSE_DETECTED = 'auth.refresh.reuse_detected',
  LOGOUT = 'auth.logout',
  LOGOUT_ALL = 'auth.logout_all',
}
