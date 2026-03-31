const nodemailer = require("nodemailer");
const logger = require("../config/logger");

const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_LOGIN,
    pass: process.env.BREVO_SMTP_KEY,
  },
});

async function sendInviteEmail({ to, inviterName, workspaceName, role, inviteUrl, isNewUser }) {
  const roleLabels = {
    admin:       "Admin",
    analyst:     "Analyst",
    media_buyer: "Media Buyer",
    ai_operator: "AI Operator",
    read_only:   "Read Only",
  };
  const roleLabel = roleLabels[role] || role;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>You're invited to AdsFlow</title>
</head>
<body style="margin:0;padding:0;background:#0f1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#1a1d27;border-radius:16px;border:1px solid #2a2d3e;overflow:hidden;">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#3B82F6,#A78BFA);padding:36px 32px;text-align:center;">
            <div style="color:white;font-size:32px;font-weight:900;letter-spacing:-1px;">Ads<span style="opacity:0.85;">Flow</span></div>
            <div style="color:rgba(255,255,255,0.75);font-size:13px;margin-top:6px;letter-spacing:0.5px;text-transform:uppercase;">Amazon Ads Dashboard</div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 40px;">
            <h1 style="color:#f1f5f9;font-size:22px;font-weight:700;margin:0 0 8px;">You've been invited!</h1>
            <p style="color:#94a3b8;font-size:15px;margin:0 0 24px;line-height:1.6;">
              <strong style="color:#e2e8f0;">${inviterName}</strong> has invited you to join
              <strong style="color:#e2e8f0;">${workspaceName}</strong> on AdsFlow
              as <strong style="color:#a78bfa;">${roleLabel}</strong>.
            </p>

            ${isNewUser ? `
            <div style="background:#1e2235;border:1px solid #2a2d3e;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
              <div style="color:#94a3b8;font-size:13px;line-height:1.6;">
                A new account will be created for <strong style="color:#e2e8f0;">${to}</strong>.
                You'll set your password when you accept the invitation.
              </div>
            </div>
            ` : `
            <div style="background:#1e2235;border:1px solid #2a2d3e;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
              <div style="color:#94a3b8;font-size:13px;line-height:1.6;">
                Click the button below to accept the invitation and access the workspace.
              </div>
            </div>
            `}

            <div style="text-align:center;margin:28px 0;">
              <a href="${inviteUrl}"
                 style="display:inline-block;background:linear-gradient(135deg,#3B82F6,#6366f1);color:white;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:15px;font-weight:600;letter-spacing:0.2px;">
                Accept Invitation →
              </a>
            </div>

            <p style="color:#64748b;font-size:12px;text-align:center;margin:0;">
              This invitation expires in 7 days. If you didn't expect this email, you can ignore it.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="border-top:1px solid #2a2d3e;padding:20px 40px;text-align:center;">
            <p style="color:#475569;font-size:11px;margin:0;">
              AdsFlow — Amazon Ads Dashboard &nbsp;·&nbsp;
              <a href="${inviteUrl}" style="color:#6366f1;text-decoration:none;">Open dashboard</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from: `"AdsFlow" <${process.env.BREVO_FROM_EMAIL}>`,
      to,
      subject: `${inviterName} invited you to ${workspaceName} on AdsFlow`,
      html,
    });
    logger.info(`Invite email sent to ${to}`);
  } catch (err) {
    logger.error(`Failed to send invite email to ${to}`, { error: err.message });
    throw err;
  }
}

async function sendPasswordResetEmail({ to, resetUrl }) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Reset your AdsFlow password</title>
</head>
<body style="margin:0;padding:0;background:#0f1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#1a1d27;border-radius:16px;border:1px solid #2a2d3e;overflow:hidden;">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#3B82F6,#A78BFA);padding:36px 32px;text-align:center;">
            <div style="color:white;font-size:32px;font-weight:900;letter-spacing:-1px;">Ads<span style="opacity:0.85;">Flow</span></div>
            <div style="color:rgba(255,255,255,0.75);font-size:13px;margin-top:6px;letter-spacing:0.5px;text-transform:uppercase;">Password Reset</div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 40px;">
            <h1 style="color:#f1f5f9;font-size:22px;font-weight:700;margin:0 0 8px;">Reset your password</h1>
            <p style="color:#94a3b8;font-size:15px;margin:0 0 24px;line-height:1.6;">
              We received a request to reset the password for your AdsFlow account
              (<strong style="color:#e2e8f0;">${to}</strong>).
              Click the button below to choose a new password.
            </p>

            <div style="background:#1e2235;border:1px solid #2a2d3e;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
              <div style="color:#94a3b8;font-size:13px;line-height:1.6;">
                This link expires in <strong style="color:#e2e8f0;">1 hour</strong> and can only be used once.
              </div>
            </div>

            <div style="text-align:center;margin:28px 0;">
              <a href="${resetUrl}"
                 style="display:inline-block;background:linear-gradient(135deg,#3B82F6,#6366f1);color:white;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:15px;font-weight:600;letter-spacing:0.2px;">
                Reset Password →
              </a>
            </div>

            <p style="color:#64748b;font-size:12px;text-align:center;margin:0;">
              If you didn't request a password reset, you can safely ignore this email.<br/>
              Your password will not be changed.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="border-top:1px solid #2a2d3e;padding:20px 40px;text-align:center;">
            <p style="color:#475569;font-size:11px;margin:0;">
              AdsFlow — Amazon Ads Dashboard &nbsp;·&nbsp;
              <a href="${resetUrl}" style="color:#6366f1;text-decoration:none;">Reset link</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from: `"AdsFlow" <${process.env.BREVO_FROM_EMAIL}>`,
      to,
      subject: "Reset your AdsFlow password",
      html,
    });
    logger.info(`Password reset email sent to ${to}`);
  } catch (err) {
    logger.error(`Failed to send password reset email to ${to}`, { error: err.message });
    throw err;
  }
}

module.exports = { sendInviteEmail, sendPasswordResetEmail };
