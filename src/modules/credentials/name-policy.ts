export const USER_NAME_MAX_CODE_POINTS = 160;

const FORBIDDEN_FORMAT_CODE_POINTS = new Set([
  0x061c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d,
  0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function containsForbiddenNameCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      FORBIDDEN_FORMAT_CODE_POINTS.has(codePoint)
    ) {
      return true;
    }
  }
  return false;
}

export function normalizeAndValidateUserName(input: string): string {
  const name = input.trim();
  if (
    name.length === 0 ||
    Array.from(name).length > USER_NAME_MAX_CODE_POINTS ||
    !isWellFormedUnicode(name) ||
    containsForbiddenNameCharacter(name)
  ) {
    throw new Error('Name does not satisfy the configured policy.');
  }
  return name;
}
