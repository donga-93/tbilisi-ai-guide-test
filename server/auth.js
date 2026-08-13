// TESTING-STAGE AUTH — no real users yet, so this just checks a shared secret
// (set PROXY_TEST_SECRET in .env) instead of standing up full user auth.
//
// When Google Sign-In lands (subscriptions stage), replace the body of
// verifyClientToken with Google ID token verification (e.g. google-auth-library's
// OAuth2Client.verifyIdToken) and return { uid: payload.sub } — server.js only
// calls verifyClientToken(idToken) and reads the returned uid, so nothing else
// needs to change.

async function verifyClientToken(idToken) {
  if (!idToken) {
    throw new Error('Missing auth token');
  }
  if (idToken !== process.env.PROXY_TEST_SECRET) {
    throw new Error('Invalid token');
  }
  return { uid: 'solo-test-user' };
}

module.exports = { verifyClientToken };
