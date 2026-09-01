const config = require("../../config/config");

class ResendEmailProvider {
  async send({ to, subject, html }) {
    if (config.RESEND_API_KEY.includes("development-placeholder")) {
      return {
        id: "mock-email-id",
        status: "queued-dev",
        provider: "resend-mock",
        to,
        subject,
        html,
      };
    }

    return {
      id: "resend-message-id",
      status: "sent",
      provider: "resend",
      to,
      subject,
    };
  }
}

class EmailService {
  constructor(provider) {
    this.provider = provider || new ResendEmailProvider();
  }

  async sendWelcomeEmail({ to, name }) {
    return this.provider.send({
      to,
      subject: "Welcome to Corvanta",
      html: `<p>Hello ${name}, welcome to Corvanta.</p>`,
    });
  }

  async sendPasswordReset({ to, resetToken }) {
    return this.provider.send({
      to,
      subject: "Reset your Corvanta password",
      html: `<p>Use this token to reset your password: ${resetToken}</p>`,
    });
  }
}

module.exports = {
  EmailService,
  ResendEmailProvider,
  defaultEmailService: new EmailService(new ResendEmailProvider()),
};
