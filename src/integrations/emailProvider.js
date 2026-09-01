const { EmailService, ResendEmailProvider } = require("../services/email/emailService");

module.exports = {
  EmailService,
  ResendEmailProvider,
  createEmailProvider: () => new EmailService(new ResendEmailProvider()),
};
