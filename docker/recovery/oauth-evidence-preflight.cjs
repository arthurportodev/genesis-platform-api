#!/usr/bin/env node
'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const PRIMARY_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FALLBACK_SCOPE = 'https://www.googleapis.com/auth/drive';
const FORBIDDEN_KEYS = new Set([
  'accesstoken',
  'authorizationcode',
  'clientsecret',
  'credentials',
  'rcloneconfig',
  'refreshtoken',
  'token',
]);

function fail(message) {
  throw new Error(`oauth-evidence: ${message}`);
}

function scanNonSecret(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanNonSecret(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z]/giu, '').toLowerCase();
    if (FORBIDDEN_KEYS.has(normalized)) fail(`forbidden secret field at ${path}.${key}`);
    scanNonSecret(entry, `${path}.${key}`);
  }
}

function validateOAuthEvidence(evidence, options = {}) {
  scanNonSecret(evidence);
  if (evidence.schemaVersion !== '0.8-MVP-07B.oauth-evidence.v1') fail('schemaVersion mismatch');
  if (evidence.evidenceKind !== 'window-r-non-secret') fail('evidenceKind mismatch');
  if (evidence.containsSecrets !== false) fail('containsSecrets must be false');
  if (evidence.account !== 'admreserva433@gmail.com') fail('dedicated account mismatch');
  if (evidence.userType !== 'external') fail('OAuth user type must be external');
  if (evidence.publishingStatus !== 'In production') fail('publishing status must be In production; Testing is rejected');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(evidence.observedAt ?? '')) fail('observedAt must be UTC ISO-8601');
  if (!Array.isArray(evidence.evidenceReferences) || evidence.evidenceReferences.length === 0 || evidence.evidenceReferences.some((entry) => typeof entry !== 'string' || entry.length < 3)) fail('non-secret evidenceReferences are required');
  if (!Array.isArray(evidence.scopes) || evidence.scopes.length !== 1) fail('exactly one OAuth scope is required');
  if (evidence.scopeMode === 'primary') {
    if (evidence.scopes[0] !== PRIMARY_SCOPE) fail('primary scope must be drive.file');
  } else if (evidence.scopeMode === 'fallback') {
    if (evidence.scopes[0] !== FALLBACK_SCOPE) fail('fallback scope must be drive');
    if (!options.allowDriveFallback || !/^GATE-[A-Z0-9-]{6,64}$/u.test(options.credentialGateId ?? '') || evidence.dedicatedAccountEmpty !== true) fail('drive fallback requires a new explicit gate and empty dedicated account proof');
  } else {
    fail('scopeMode must be primary or fallback');
  }
  return { status: 'accepted', publishingStatus: evidence.publishingStatus, scope: evidence.scopes[0], account: evidence.account };
}

function parseArguments(args) {
  const options = { allowDriveFallback: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--evidence') options.evidencePath = args[++index];
    else if (arg === '--allow-drive-fallback') options.allowDriveFallback = true;
    else if (arg === '--credential-gate-id') options.credentialGateId = args[++index];
    else fail(`unknown argument: ${arg}`);
  }
  if (!options.evidencePath) fail('--evidence is required');
  return options;
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const evidence = JSON.parse(readFileSync(resolve(options.evidencePath), 'utf8'));
    process.stdout.write(`${JSON.stringify(validateOAuthEvidence(evidence, options))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { FALLBACK_SCOPE, PRIMARY_SCOPE, scanNonSecret, validateOAuthEvidence };
