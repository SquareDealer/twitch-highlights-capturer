import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** In-memory login sessions: a random 32-byte hex token per login, valid for 30 days. */
export class Sessions {
  private readonly tokens = new Map<string, number>();

  constructor(
    private readonly password: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns a new session token, or null for a wrong password. */
  login(password: string): string | null {
    if (!timingSafeEqual(sha256(password), sha256(this.password))) return null;
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, this.now() + SESSION_TTL_MS);
    return token;
  }

  valid(token: string | undefined): boolean {
    if (!token) return false;
    const expires = this.tokens.get(token);
    if (expires === undefined) return false;
    if (this.now() >= expires) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  logout(token: string): void {
    this.tokens.delete(token);
  }
}
