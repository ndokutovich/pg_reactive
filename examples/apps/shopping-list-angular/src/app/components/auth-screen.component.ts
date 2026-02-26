import { Component, EventEmitter, Output, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-auth-screen',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="screen-animate">
      <div class="auth-wrap">
        <div class="card">
          <div class="card-body">
            <div class="auth-header">
              <h2>{{ isSignUp() ? 'Sign Up' : 'Log In' }}</h2>
              <p class="subtitle">
                {{ isSignUp() ? 'Create your account to start shopping together' : 'Welcome back!' }}
              </p>
            </div>
            @if (errorMessage()) {
              <div class="alert alert-error">{{ errorMessage() }}</div>
            }
            <form (ngSubmit)="handleAuth()">
              <div class="form-group">
                <label for="auth-email">Email</label>
                <input
                  type="email"
                  id="auth-email"
                  class="input"
                  placeholder="you@example.com"
                  required
                  autocomplete="email"
                  [(ngModel)]="email"
                  name="email">
              </div>
              <div class="form-group">
                <label for="auth-password">Password</label>
                <input
                  type="password"
                  id="auth-password"
                  class="input"
                  placeholder="At least 6 characters"
                  required
                  minlength="6"
                  autocomplete="current-password"
                  [(ngModel)]="password"
                  name="password">
              </div>
              <button
                type="submit"
                class="btn btn-primary btn-full"
                [disabled]="loading()">
                {{ loading() ? 'Please wait...' : (isSignUp() ? 'Sign Up' : 'Log In') }}
              </button>
            </form>
            <div class="auth-toggle">
              <span>{{ isSignUp() ? 'Already have an account? ' : 'Need an account? ' }}</span>
              <a (click)="toggleMode()">{{ isSignUp() ? 'Log In' : 'Sign Up' }}</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
})
export class AuthScreenComponent {
  @Output() authenticated = new EventEmitter<void>();

  isSignUp = signal(true);
  loading = signal(false);
  errorMessage = signal('');
  email = '';
  password = '';

  constructor(private auth: AuthService) {}

  toggleMode(): void {
    this.isSignUp.update(v => !v);
    this.errorMessage.set('');
  }

  async handleAuth(): Promise<void> {
    const email = this.email.trim();
    const pw = this.password;
    if (!email || !pw) return;

    this.errorMessage.set('');
    this.loading.set(true);

    try {
      if (this.isSignUp()) {
        await this.auth.signup(email, pw);
      } else {
        await this.auth.login(email, pw);
      }
      this.authenticated.emit();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage.set(msg);
    } finally {
      this.loading.set(false);
    }
  }
}
