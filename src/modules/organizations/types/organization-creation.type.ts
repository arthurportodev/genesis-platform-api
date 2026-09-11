export interface OrganizationCreationRequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CreatedOrganizationResponse {
  id: string;
  name: string;
  slug: string;
  membershipId: string;
  role: 'owner';
}

export interface OrganizationCreationResult {
  response: CreatedOrganizationResponse;
  replayed: boolean;
}
