const Conversation = require("../models/Conversation");
const AppError = require("../utils/AppError");
const Message = require("../models/Message");
const { createMessage, getOwnedConversation, publicMessage } = require("./messageService");
const { deliverStaffReply } = require("./connectors/inboundService");

const MAX_REPLY_CHARS = 5000;

/**
 * A team member answers the customer directly (the AI is not involved).
 *
 * Rules:
 *  - the conversation must be in HUMAN mode, so the AI never talks over a person: take over first;
 *  - archived conversations are closed to replies;
 *  - a reply to an open conversation moves it to "waiting" (waiting for the customer);
 *  - a reply to an unassigned conversation assigns it to the replying team member;
 *  - on WhatsApp, Messenger, Instagram, SMS and email the reply is also sent through that channel. The
 *    reply is always saved first; if sending fails it is kept and marked failed, never reported as sent.
 */
async function sendStaffReply(companyId, conversationId, rawBody, actor) {
  if (!actor || !actor._id || String(actor.companyId) !== String(companyId)) {
    throw new AppError(403, "Authenticated user is not a member of this company.");
  }

  const body = typeof rawBody === "string" ? rawBody.trim() : "";
  if (!body) throw new AppError(400, "Reply cannot be empty.");
  if (body.length > MAX_REPLY_CHARS) {
    throw new AppError(400, `Reply must be at most ${MAX_REPLY_CHARS} characters.`);
  }

  const conversation = await getOwnedConversation(companyId, conversationId);
  if (conversation.status === "archived") {
    throw new AppError(409, "This conversation is archived.");
  }
  if (conversation.handlingMode !== "HUMAN") {
    throw new AppError(409, "Take over this conversation before replying.");
  }

  const message = await createMessage(companyId, conversation._id, { body, senderType: "user" }, actor);

  await Conversation.updateOne({ _id: conversation._id, companyId, status: "open" }, { $set: { status: "waiting" } });
  await Conversation.updateOne(
    { _id: conversation._id, companyId, assigneeId: null },
    { $set: { assigneeId: actor._id } }
  );

  const delivery = await deliverStaffReply(companyId, conversation, message);
  if (!delivery) return publicMessage(message);
  const updated = await Message.findOne({ _id: message._id, companyId }).lean();
  return publicMessage(updated || message);
}

module.exports = { sendStaffReply, MAX_REPLY_CHARS };
