const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FALLBACK_SCOPE,
  PRIMARY_SCOPE,
  validateOAuthEvidence,
} = require('../../docker/recovery/oauth-evidence-preflight.cjs');

function evidence(overrides = {}) {
  return {
    schemaVersion: '0.8-MVP-07B.oauth-evidence.v1',
    evidenceKind: 'window-r-non-secret',
    containsSecrets: false,
    account: 'admreserva433@gmail.com',
    userType: 'external',
    publishingStatus: 'In production',
    scopeMode: 'primary',
    scopes: [PRIMARY_SCOPE],
    observedAt: '2026-08-12T18:00:00Z',
    evidenceReferences: ['google-console-screen-reference-01'],
    ...overrides,
  };
}

test('accepts non-secret In production evidence for exact drive.file scope', () => {
  assert.deepEqual(validateOAuthEvidence(evidence()), {
    status: 'accepted',
    publishingStatus: 'In production',
    scope: PRIMARY_SCOPE,
    account: 'admreserva433@gmail.com',
  });
});

test('rejects external OAuth left in Testing', () => {
  assert.throws(
    () => validateOAuthEvidence(evidence({ publishingStatus: 'Testing' })),
    /must be In production; Testing is rejected/u,
  );
});

for (const forbidden of [
  { clientSecret: 'never' },
  { accessToken: 'never' },
  { refreshToken: 'never' },
  { nested: { authorizationCode: 'never' } },
  { rcloneConfig: 'never' },
]) {
  test(`rejects secret-bearing evidence field ${Object.keys(forbidden)[0]}`, () => {
    assert.throws(
      () => validateOAuthEvidence(evidence(forbidden)),
      /forbidden secret field/u,
    );
  });
}

test('drive fallback requires a new explicit gate and empty-account proof', () => {
  const fallback = evidence({
    scopeMode: 'fallback',
    scopes: [FALLBACK_SCOPE],
    dedicatedAccountEmpty: true,
  });
  assert.throws(() => validateOAuthEvidence(fallback), /new explicit gate/u);
  assert.equal(
    validateOAuthEvidence(fallback, {
      allowDriveFallback: true,
      credentialGateId: 'GATE-DRIVE-FALLBACK-01',
    }).scope,
    FALLBACK_SCOPE,
  );
  assert.throws(
    () =>
      validateOAuthEvidence(
        { ...fallback, dedicatedAccountEmpty: false },
        {
          allowDriveFallback: true,
          credentialGateId: 'GATE-DRIVE-FALLBACK-01',
        },
      ),
    /empty dedicated account proof/u,
  );
});

test('rejects wrong account, unprovable status, or expanded scope set', () => {
  assert.throws(
    () => validateOAuthEvidence(evidence({ account: 'other@example.com' })),
    /dedicated account mismatch/u,
  );
  assert.throws(
    () => validateOAuthEvidence(evidence({ publishingStatus: undefined })),
    /publishing status/u,
  );
  assert.throws(
    () =>
      validateOAuthEvidence(
        evidence({ scopes: [PRIMARY_SCOPE, FALLBACK_SCOPE] }),
      ),
    /exactly one OAuth scope/u,
  );
});

test('accepted evidence remains token- and secret-free when serialized', () => {
  const serialized = JSON.stringify(evidence()).toLowerCase();
  assert.doesNotMatch(
    serialized,
    /clientsecret|accesstoken|refreshtoken|authorizationcode|rcloneconfig/u,
  );
});
