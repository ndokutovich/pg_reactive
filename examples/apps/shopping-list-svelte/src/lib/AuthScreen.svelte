<script>
  import { accessToken, currentUser, currentScreen, addToast } from '../stores.js';
  import { API_BASE, saveSession } from '../api.js';

  let isSignUp = true;
  let email = '';
  let password = '';
  let error = '';
  let submitting = false;

  $: title = isSignUp ? 'Sign Up' : 'Log In';
  $: subtitle = isSignUp ? 'Create your account to start shopping together' : 'Welcome back!';
  $: submitLabel = isSignUp ? 'Sign Up' : 'Log In';
  $: toggleText = isSignUp ? 'Already have an account?' : 'Need an account?';
  $: toggleLabel = isSignUp ? 'Log In' : 'Sign Up';

  function toggleMode() {
    isSignUp = !isSignUp;
    error = '';
  }

  async function handleSubmit() {
    error = '';
    submitting = true;

    let url, body;
    if (isSignUp) {
      url = API_BASE + '/auth/v1/signup';
      body = { email, password };
    } else {
      url = API_BASE + '/auth/v1/token';
      body = { grant_type: 'password', email, password };
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Auth failed');

      $accessToken = data.access_token;
      $currentUser = data.user;
      saveSession(data);
      location.hash = '#/lists';
    } catch (err) {
      error = err.message;
    } finally {
      submitting = false;
    }
  }
</script>

<div class="auth-wrap">
  <div class="card">
    <div class="card-body">
      <div class="auth-header">
        <h2>{title}</h2>
        <p class="subtitle">{subtitle}</p>
      </div>

      {#if error}
        <div class="alert alert-error">{error}</div>
      {/if}

      <form on:submit|preventDefault={handleSubmit}>
        <div class="form-group">
          <label for="auth-email">Email</label>
          <input
            type="email"
            id="auth-email"
            class="input"
            placeholder="you@example.com"
            required
            autocomplete="email"
            bind:value={email}
          >
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
            bind:value={password}
          >
        </div>
        <button type="submit" class="btn btn-primary btn-full" disabled={submitting}>
          {#if submitting}
            Please wait...
          {:else}
            {submitLabel}
          {/if}
        </button>
      </form>

      <div class="auth-toggle">
        <span>{toggleText} </span>
        <!-- svelte-ignore a11y-invalid-attribute -->
        <a href="#toggle" on:click|preventDefault={toggleMode}>{toggleLabel}</a>
      </div>
    </div>
  </div>
</div>
