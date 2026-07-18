/**
 * Login page HTML for the OAuth authorization flow.
 *
 * Uses Firebase Auth JS SDK (compat) for Google, GitHub, Microsoft sign-in.
 * On successful login, POSTs the Firebase ID token to /callback,
 * which verifies it and completes the OAuth flow.
 *
 * Design: Frihet monochrome (#171717), clean, professional, responsive.
 */

export function getLoginPage(opts: {
  stateKey: string;
  clientId: string;
  firebaseProjectId: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect to Frihet</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #fafafa;
      color: #171717;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      background: white;
      border: 1px solid #e5e5e5;
      border-radius: 12px;
      padding: 2.5rem;
      max-width: 420px;
      width: 100%;
    }
    .logo {
      width: 48px;
      height: 48px;
      margin: 0 auto 1.5rem;
      display: block;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      text-align: center;
      margin-bottom: 0.5rem;
    }
    .subtitle {
      color: #737373;
      font-size: 0.875rem;
      text-align: center;
      margin-bottom: 2rem;
      line-height: 1.5;
    }
    .client-info {
      background: #f5f5f5;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      margin-bottom: 1.5rem;
      font-size: 0.8125rem;
      color: #525252;
    }
    .permissions {
      margin-bottom: 1.5rem;
      font-size: 0.8125rem;
    }
    .permissions h3 {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #737373;
      margin-bottom: 0.5rem;
    }
    .permissions li {
      list-style: none;
      padding: 0.25rem 0;
      padding-left: 1.25rem;
      position: relative;
    }
    .permissions li::before {
      content: '\\2713';
      position: absolute;
      left: 0;
      color: #171717;
      font-weight: 600;
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
      width: 100%;
      padding: 0.75rem 1rem;
      border: 1px solid #e5e5e5;
      border-radius: 8px;
      background: white;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
      margin-bottom: 0.75rem;
      color: #171717;
    }
    .btn:hover { background: #f5f5f5; border-color: #d4d4d4; }
    .btn:active { background: #e5e5e5; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn svg { width: 20px; height: 20px; flex-shrink: 0; }
    .divider {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin: 1rem 0;
      font-size: 0.75rem;
      color: #a3a3a3;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .divider::before, .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #e5e5e5;
    }
    .input {
      width: 100%;
      padding: 0.75rem 1rem;
      border: 1px solid #e5e5e5;
      border-radius: 8px;
      font-size: 0.875rem;
      margin-bottom: 0.75rem;
      color: #171717;
      outline: none;
      transition: border-color 0.15s;
    }
    .input:focus { border-color: #171717; }
    .btn-primary {
      background: #171717;
      color: white;
      border-color: #171717;
    }
    .btn-primary:hover { background: #2a2a2a; border-color: #2a2a2a; }
    .error {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 8px;
      padding: 0.75rem;
      margin-bottom: 1rem;
      font-size: 0.8125rem;
      color: #dc2626;
      display: none;
    }
    .loading {
      display: none;
      text-align: center;
      padding: 2rem;
    }
    .loading .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid #e5e5e5;
      border-top-color: #171717;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .footer {
      margin-top: 1.5rem;
      text-align: center;
      font-size: 0.75rem;
      color: #a3a3a3;
    }
    .footer a { color: #737373; text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <svg class="logo" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Frihet">
      <circle cx="24" cy="24" r="22" fill="#171717"/>
    </svg>
    <h1>Connect to Frihet</h1>
    <p class="subtitle">
      An application wants to access your Frihet account to manage
      invoices, expenses, clients, and more via AI.
    </p>

    <div class="client-info">
      Requested by: <strong id="clientId"></strong>
    </div>

    <div class="permissions">
      <h3>This will allow access to:</h3>
      <ul>
        <li>View and create invoices</li>
        <li>View and create expenses</li>
        <li>View and manage clients</li>
        <li>View and manage products</li>
        <li>View and create quotes</li>
      </ul>
    </div>

    <div id="error" class="error"></div>

    <div id="buttons">
      <button class="btn" onclick="signIn('google')">
        <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
        Continue with Google
      </button>
      <button class="btn" onclick="signIn('github')">
        <svg viewBox="0 0 24 24"><path fill="#171717" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/></svg>
        Continue with GitHub
      </button>
      <button class="btn" onclick="signIn('microsoft')">
        <svg viewBox="0 0 24 24"><rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="13" y="1" width="10" height="10" fill="#7FBA00"/><rect x="1" y="13" width="10" height="10" fill="#00A4EF"/><rect x="13" y="13" width="10" height="10" fill="#FFB900"/></svg>
        Continue with Microsoft
      </button>

      <div class="divider">or</div>

      <input type="email" id="email" class="input" placeholder="Email address" autocomplete="email" />
      <input type="password" id="password" class="input" placeholder="Password" autocomplete="current-password" />
      <button class="btn btn-primary" onclick="signInWithEmail()">
        Sign in with email
      </button>
    </div>

    <div id="loading" class="loading">
      <div class="spinner"></div>
      <p>Connecting your account...</p>
    </div>

    <div class="footer">
      <a href="https://www.frihet.io/en/privacy" target="_blank">Privacy Policy</a>
      &middot;
      <a href="https://docs.frihet.io" target="_blank">Documentation</a>
    </div>
  </div>

  <script type="application/json" id="server-data">${JSON.stringify({
    clientId: opts.clientId,
    stateKey: opts.stateKey,
    firebaseProjectId: opts.firebaseProjectId,
  })}<\/script>
  <script src="https://www.gstatic.com/firebasejs/11.0.0/firebase-app-compat.js"><\/script>
  <script src="https://www.gstatic.com/firebasejs/11.0.0/firebase-auth-compat.js"><\/script>
  <script>
    var SERVER_DATA = JSON.parse(document.getElementById("server-data").textContent);

    firebase.initializeApp({
      apiKey: "AIzaSyAZLelo5vQNvTl0oYqr0vAu19HAabMaVLk",
      authDomain: "auth.frihet.io",
      projectId: SERVER_DATA.firebaseProjectId,
    });

    var STATE_KEY = SERVER_DATA.stateKey;
    document.getElementById("clientId").textContent = SERVER_DATA.clientId;

    function showError(msg) {
      var el = document.getElementById("error");
      el.textContent = msg;
      el.style.display = "block";
    }

    function showLoading() {
      document.getElementById("buttons").style.display = "none";
      document.getElementById("loading").style.display = "block";
    }

    function hideLoading() {
      document.getElementById("buttons").style.display = "block";
      document.getElementById("loading").style.display = "none";
    }

    async function signInWithEmail() {
      document.getElementById("error").style.display = "none";
      var email = document.getElementById("email").value.trim();
      var password = document.getElementById("password").value;
      if (!email || !password) {
        showError("Please enter email and password.");
        return;
      }
      try {
        var result = await firebase.auth().signInWithEmailAndPassword(email, password);
        var idToken = await result.user.getIdToken();
        showLoading();
        var response = await fetch("/callback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stateKey: STATE_KEY,
            idToken: idToken,
            locale: navigator.language.startsWith("es") ? "es" : "en",
          }),
        });
        if (!response.ok) {
          var err = await response.json();
          throw new Error(err.error || "Authentication failed");
        }
        var data = await response.json();
        window.location.href = data.redirectTo;
      } catch (err) {
        hideLoading();
        showError(err.message || "Authentication failed. Please try again.");
      }
    }

    async function signIn(provider) {
      document.getElementById("error").style.display = "none";

      var authProvider;
      switch (provider) {
        case "google":
          authProvider = new firebase.auth.GoogleAuthProvider();
          break;
        case "github":
          authProvider = new firebase.auth.GithubAuthProvider();
          break;
        case "microsoft":
          authProvider = new firebase.auth.OAuthProvider("microsoft.com");
          break;
      }

      try {
        var result = await firebase.auth().signInWithPopup(authProvider);
        var idToken = await result.user.getIdToken();

        showLoading();

        var response = await fetch("/callback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stateKey: STATE_KEY,
            idToken: idToken,
            locale: navigator.language.startsWith("es") ? "es" : "en",
          }),
        });

        if (!response.ok) {
          var err = await response.json();
          throw new Error(err.error || "Authentication failed");
        }

        var data = await response.json();
        window.location.href = data.redirectTo;
      } catch (err) {
        hideLoading();
        showError(err.message || "Authentication failed. Please try again.");
      }
    }
  <\/script>
</body>
</html>`;
}
