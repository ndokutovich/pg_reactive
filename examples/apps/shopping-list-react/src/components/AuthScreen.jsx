import React, { useState, useCallback } from 'react';
import { API_BASE } from '../api';

export default function AuthScreen({ onLogin }) {
  const [isSignUp, setIsSignUp] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const toggleMode = useCallback(() => {
    setIsSignUp((prev) => !prev);
    setError('');
  }, []);

  const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      setError('');
      setLoading(true);

      const url = isSignUp
        ? API_BASE + '/auth/v1/signup'
        : API_BASE + '/auth/v1/token';

      const body = isSignUp
        ? { email: email.trim(), password }
        : { grant_type: 'password', email: email.trim(), password };

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || data.message || 'Auth failed');
        onLogin(data.access_token, data.user, data.refresh_token);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [isSignUp, email, password, onLogin]
  );

  return (
    <div className="screen active">
      <div className="auth-wrap">
        <div className="card">
          <div className="card-body">
            <div className="auth-header">
              <h2>{isSignUp ? 'Sign Up' : 'Log In'}</h2>
              <p className="subtitle">
                {isSignUp
                  ? 'Create your account to start shopping together'
                  : 'Welcome back!'}
              </p>
            </div>

            {error && (
              <div className="alert visible alert-error">{error}</div>
            )}

            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label htmlFor="auth-email">Email</label>
                <input
                  type="email"
                  id="auth-email"
                  className="input"
                  placeholder="you@example.com"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label htmlFor="auth-password">Password</label>
                <input
                  type="password"
                  id="auth-password"
                  className="input"
                  placeholder="At least 6 characters"
                  required
                  minLength={6}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <button
                type="submit"
                className="btn btn-primary btn-full"
                disabled={loading}
              >
                {loading ? 'Please wait...' : isSignUp ? 'Sign Up' : 'Log In'}
              </button>
            </form>

            <div className="auth-toggle">
              <span>
                {isSignUp ? 'Already have an account? ' : 'Need an account? '}
              </span>
              <a onClick={toggleMode}>
                {isSignUp ? 'Log In' : 'Sign Up'}
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
