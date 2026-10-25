/** The public address of this API, for URLs shown to business users (webhook addresses, embed codes). */
function publicBaseUrl(req) {
  if (process.env.PUBLIC_API_URL) return String(process.env.PUBLIC_API_URL).replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

module.exports = { publicBaseUrl };
