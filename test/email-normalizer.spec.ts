import { normalizeEmail } from '../src/common/normalization/email.normalizer';
import { User } from '../src/modules/users/entities/user.entity';

describe('normalizeEmail characterization', () => {
  it.each([
    ['  Arthur@Example.COM  ', 'arthur@example.com'],
    ['USER+Tag@EXAMPLE.COM', 'user+tag@example.com'],
    ['  üSER@EXAMPLE.COM  ', 'üser@example.com'],
  ])('preserves the existing trim/lower behavior for %s', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);

    const user = new User();
    user.email = input;
    user.name = 'User';
    user.normalize();
    expect(user.email).toBe(expected);
  });

  it('does not perform Unicode normalization', () => {
    expect(normalizeEmail('e\u0301@example.com')).toBe('e\u0301@example.com');
    expect(normalizeEmail('é@example.com')).toBe('é@example.com');
    expect(normalizeEmail('e\u0301@example.com')).not.toBe(
      normalizeEmail('é@example.com'),
    );
  });
});
