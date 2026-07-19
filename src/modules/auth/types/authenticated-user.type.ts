export interface AuthenticatedUser {
  userId: string;
  sessionId: string;
}

export interface AuthRequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'inactive';
}
