import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Request, Response } from 'express';
import { AppConfig } from '../../../config/app.config';

const PRODUCTION_REFRESH_COOKIE = '__Host-genesis_refresh';
const NON_PRODUCTION_REFRESH_COOKIE = 'genesis_refresh_dev';
const PRODUCTION_CSRF_COOKIE = '__Host-genesis_csrf';
const NON_PRODUCTION_CSRF_COOKIE = 'genesis_csrf_dev';
const CSRF_HEADER = 'x-csrf-token';
const CSRF_ERROR = 'CSRF validation failed.';

@Injectable()
export class WebSessionService {
  private readonly appConfig: AppConfig;
  private readonly secureCookies: boolean;

  constructor(configService: ConfigService) {
    this.appConfig = configService.getOrThrow<AppConfig>('app');
    this.secureCookies = this.appConfig.environment === 'production';
  }

  issueCsrfToken(response: Response): string {
    const token = randomBytes(32).toString('base64url');
    response.cookie(this.csrfCookieName, token, {
      httpOnly: false,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/',
    });
    return token;
  }

  setRefreshCookie(
    response: Response,
    refreshToken: string,
    expiresAt: Date,
  ): void {
    response.cookie(this.refreshCookieName, refreshToken, {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
  }

  clearAuthCookies(response: Response): void {
    response.clearCookie(this.refreshCookieName, {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/',
    });
    response.clearCookie(this.csrfCookieName, {
      httpOnly: false,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/',
    });
  }

  getRefreshToken(request: Request): string | null {
    return this.readCookie(request, this.refreshCookieName);
  }

  assertCsrf(request: Request): void {
    const cookieToken = this.readCookie(request, this.csrfCookieName);
    const headerToken = request.get(CSRF_HEADER);
    const origin = request.get('origin');

    if (
      cookieToken === null ||
      headerToken === undefined ||
      !this.secureEqual(cookieToken, headerToken) ||
      (origin !== undefined && origin !== this.appConfig.frontendUrl)
    ) {
      throw new ForbiddenException(CSRF_ERROR);
    }
  }

  private get refreshCookieName(): string {
    return this.secureCookies
      ? PRODUCTION_REFRESH_COOKIE
      : NON_PRODUCTION_REFRESH_COOKIE;
  }

  private get csrfCookieName(): string {
    return this.secureCookies
      ? PRODUCTION_CSRF_COOKIE
      : NON_PRODUCTION_CSRF_COOKIE;
  }

  private readCookie(request: Request, name: string): string | null {
    const cookieHeader = request.headers.cookie;
    if (cookieHeader === undefined) {
      return null;
    }

    const values: string[] = [];
    for (const segment of cookieHeader.split(';')) {
      const separator = segment.indexOf('=');
      if (separator < 0 || segment.slice(0, separator).trim() !== name) {
        continue;
      }
      const encodedValue = segment.slice(separator + 1).trim();
      try {
        values.push(decodeURIComponent(encodedValue));
      } catch {
        return null;
      }
    }
    return values.length === 1 && values[0].length > 0 ? values[0] : null;
  }

  private secureEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');
    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  }
}
