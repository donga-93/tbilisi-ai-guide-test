// server/welcomeEmailHtml.js
//
// Builds the branded HTML welcome email using strings from the same
// `texts` object welcomeEmail.js already loads via loadLocaleTexts()
// (i.e. an entry from server/emailLocales.json).

function buildWelcomeEmailHtml(texts, link) {
  const s = texts || {};

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Georgia Travel AI Guide</title>
</head>
<body style="margin:0; padding:0; background-color:#0c0c16; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">

  <div style="display:none; max-height:0; overflow:hidden; opacity:0;">
    ${s.welcomeEmailPreheader || ""}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0c0c16; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; background-color:#13131f; border-radius:16px; overflow:hidden; border:1px solid rgba(255,255,255,0.08);">

          <tr>
            <td align="center" style="padding: 40px 32px 24px 32px; background: linear-gradient(135deg, #1a1a2e 0%, #0c0c16 100%);">
              <div style="width:64px; height:64px; border-radius:20px; background-color:rgba(232,183,107,0.12); border:1px solid rgba(232,183,107,0.30); display:inline-block; line-height:64px; font-size:30px; margin-bottom:16px;">
                🏰
              </div>
              <h1 style="margin:0; color:#ffffff; font-size:22px; font-weight:800; letter-spacing:0.2px;">
                Georgia Travel AI Guide
              </h1>
            </td>
          </tr>

          <tr>
            <td style="padding: 8px 32px 8px 32px;">
              <h2 style="color:#ffffff; font-size:20px; font-weight:700; margin: 16px 0 8px 0;">
                ${s.welcomeEmailGreeting || ""}
              </h2>
              <p style="color:rgba(232,232,232,0.82); font-size:15px; line-height:24px; margin: 0 0 20px 0;">
                ${s.welcomeEmailIntro || ""}
              </p>
              <p style="color:rgba(232,232,232,0.82); font-size:15px; line-height:24px; margin: 0 0 24px 0;">
                ${s.welcomeEmailOffer || ""}
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 auto 28px auto;">
                <tr>
                  <td align="center" style="border-radius:14px; background-color:#22C55E;">
                    <a href="${link}" target="_blank" style="display:inline-block; padding:14px 32px; font-size:15px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:14px;">
                      ${s.welcomeEmailButton || ""}
                    </a>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid rgba(255,255,255,0.08); padding-top:20px; margin-bottom: 8px;">
                <tr>
                  <td style="padding: 6px 0; color:rgba(232,232,232,0.75); font-size:14px;">
                    🗺️&nbsp;&nbsp;${s.welcomeEmailFeature1 || ""}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color:rgba(232,232,232,0.75); font-size:14px;">
                    🎙️&nbsp;&nbsp;${s.welcomeEmailFeature2 || ""}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color:rgba(232,232,232,0.75); font-size:14px;">
                    📍&nbsp;&nbsp;${s.welcomeEmailFeature3 || ""}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding: 8px 32px;">
              <div style="height:1px; background-color:rgba(255,255,255,0.08);"></div>
            </td>
          </tr>

          <tr>
            <td style="padding: 24px 32px 32px 32px;">
              <p style="color:rgba(255,255,255,0.40); font-size:12px; line-height:19px; margin:0 0 8px 0;">
                ${s.welcomeEmailFooterQuestion || ""}
              </p>
              <p style="color:rgba(255,255,255,0.30); font-size:12px; line-height:19px; margin:0;">
                ${s.welcomeEmailFooterLocation || ""}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}

module.exports = { buildWelcomeEmailHtml };
