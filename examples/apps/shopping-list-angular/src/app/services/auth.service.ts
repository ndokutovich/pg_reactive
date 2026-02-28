import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

const m = location.pathname.match(/^(.*?)\/apps\//);
const base = m ? m[1] : '';
const API_BASE = location.origin + base;
const ANON_KEY = 'anon-key-12345';

export interface User {
  id: string;
  email: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private tokenSubject = new BehaviorSubject<string | null>(null);
  private userSubject = new BehaviorSubject<User | null>(null);
  private readonly SESSION_KEY = 'wtb-session';

  token$ = this.tokenSubject.asObservable();
  user$ = this.userSubject.asObservable();

  getToken(): string | null {
    return this.tokenSubject.value;
  }

  getUser(): User | null {
    return this.userSubject.value;
  }

  parseJwt(token: string): Record<string, unknown> | null {
    try {
      const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(b64 + '=='.slice(0, (4 - b64.length % 4) % 4)));
    } catch {
      return null;
    }
  }

  private saveSession(data: { access_token: string; refresh_token?: string; user: User }): void {
    const session = { access_token: data.access_token, refresh_token: data.refresh_token, user: data.user };
    localStorage.setItem(this.SESSION_KEY, JSON.stringify(session));
  }

  loadSession(): { access_token: string; refresh_token: string; user: User } | null {
    try { return JSON.parse(localStorage.getItem(this.SESSION_KEY) || 'null'); } catch { return null; }
  }

  private clearSession(): void {
    localStorage.removeItem(this.SESSION_KEY);
  }

  async signup(email: string, password: string): Promise<void> {
    const res = await fetch(API_BASE + '/auth/v1/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || data.message || 'Signup failed');
    }
    this.tokenSubject.next(data.access_token);
    this.userSubject.next(data.user);
    this.saveSession(data);
  }

  async login(email: string, password: string): Promise<void> {
    const res = await fetch(API_BASE + '/auth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || data.message || 'Login failed');
    }
    this.tokenSubject.next(data.access_token);
    this.userSubject.next(data.user);
    this.saveSession(data);
  }

  logout(): void {
    const token = this.tokenSubject.value;
    if (token) {
      fetch(API_BASE + '/auth/v1/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': ANON_KEY,
          'Authorization': 'Bearer ' + token
        }
      }).catch(() => { /* ignore */ });
    }
    this.tokenSubject.next(null);
    this.userSubject.next(null);
    this.clearSession();
  }

  async tryRefresh(): Promise<boolean> {
    const session = this.loadSession();
    if (!session || !session.refresh_token) return false;

    try {
      const res = await fetch(API_BASE + '/auth/v1/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: session.refresh_token })
      });
      const data = await res.json();
      if (!data.access_token) { this.clearSession(); return false; }

      this.tokenSubject.next(data.access_token);
      this.userSubject.next(data.user);
      this.saveSession(data);
      return true;
    } catch {
      this.clearSession();
      return false;
    }
  }

  restoreSession(): boolean {
    const session = this.loadSession();
    if (!session || !session.access_token) return false;

    const claims = this.parseJwt(session.access_token);
    if (!claims) { this.clearSession(); return false; }

    if (claims['exp'] && (claims['exp'] as number) * 1000 < Date.now()) {
      // Token expired, try async refresh
      this.tryRefresh();
      return false;
    }

    this.tokenSubject.next(session.access_token);
    this.userSubject.next(session.user);
    return true;
  }

  refreshIfNeeded(): void {
    const token = this.getToken();
    if (!token) return;
    const claims = this.parseJwt(token);
    if (claims && claims['exp'] && (claims['exp'] as number) * 1000 < Date.now()) {
      this.tryRefresh();
    }
  }
}
