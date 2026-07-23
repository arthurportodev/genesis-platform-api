import { BadRequestException } from '@nestjs/common';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function normalizeLeadPhone(value: string): string {
  const phone = parsePhoneNumberFromString(value.trim(), 'BR');
  if (phone === undefined || phone.ext !== undefined || !phone.isPossible()) {
    throw new BadRequestException('Invalid lead phone.');
  }
  return phone.number;
}
