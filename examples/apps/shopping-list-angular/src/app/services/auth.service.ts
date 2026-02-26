import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

const API_BASE = 'http://127.0.0.1:8080';
const ANON_KEY = 'anon-key-12345';

export interface User {
  id: string;
  email: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private tokenSubject = new BehaviorSubject<string | null>(null);
  private userSubject = new BehaviorSubject<User | null>(null);

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
  }
}
