const fs = require("fs");
const path = require("path");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const widgetService = require("../services/widgetService");
const { logAudit } = require("../services/auditService");

const EMBED_SCRIPT = fs.readFileSync(path.join(__dirname, "..", "widget", "embed.js"), "utf8");

function publicBaseUrl(req) {
  if (process.env.PUBLIC_API_URL) return String(process.env.PUBLIC_API_URL).replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

// ---- Dashboard (JWT-protected) -------------------------------------------------------------

exports.getWidgetSettings = asyncHandler(async (req, res) => {
  const view = await widgetService.getWidgetSettings(req.user.companyId, req.params.id, publicBaseUrl(req));
  res.status(200).json({ success: true, data: view });
});

exports.saveWidgetSettings = asyncHandler(async (req, res) => {
  const { view, rotated } = await widgetService.saveWidgetSettings(
    req.user.companyId,
    req.params.id,
    req.body || {},
    publicBaseUrl(req)
  );
  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "channel.widget.updated",
    entityType: "Channel",
    entityId: String(req.params.id),
    metadata: { rotatedKey: rotated, originCount: view.widget.allowedOrigins.length, enabled: view.enabled },
  });
  res.status(200).json({ success: true, data: view });
});

// ---- Public widget (no JWT; scoped by public key + visitor token) ---------------------------

exports.serveEmbed = (req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).send(EMBED_SCRIPT);
};

exports.getConfig = asyncHandler(async (req, res) => {
  const config = await widgetService.getPublicConfig(req.widgetChannel);
  res.status(200).json({ success: true, data: config });
});

exports.startOrResumeSession = asyncHandler(async (req, res) => {
  const channel = req.widgetChannel;
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(\S+)$/.exec(header);

  let result = null;
  if (match) {
    try {
      result = await widgetService.resumeSession(channel, match[1]);
    } catch (error) {
      if (!(error instanceof AppError) || error.statusCode !== 401) throw error;
    }
  }
  if (!result) result = await widgetService.createSession(channel, { name: req.body && req.body.name });

  const config = await widgetService.getPublicConfig(channel);
  res.status(200).json({ success: true, data: { ...result, config } });
});

exports.listMessages = asyncHandler(async (req, res) => {
  const result = await widgetService.listVisitorMessages(req.widgetChannel, req.widgetToken, req.query.after);
  res.status(200).json({ success: true, data: result });
});

exports.sendMessage = asyncHandler(async (req, res) => {
  const result = await widgetService.sendVisitorMessage(req.widgetChannel, req.widgetToken, req.body && req.body.body);
  res.status(200).json({ success: true, data: result });
});
