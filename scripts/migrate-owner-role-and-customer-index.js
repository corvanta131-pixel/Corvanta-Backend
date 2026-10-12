/**
 * One-time migration for the multi-tenancy and customer-email fixes.
 *
 *   node scripts/migrate-owner-role-and-customer-index.js            (dry run, changes nothing)
 *   node scripts/migrate-owner-role-and-customer-index.js --apply    (performs the changes)
 *
 * 1. Renames every existing role with slug "super-admin" to slug "owner" / name "Owner".
 *    Before this fix every company owner received a "super-admin" role, which the backend treated
 *    as platform admin. If you want a real platform admin afterwards, set that one role's slug to
 *    "platform-admin" by hand.
 * 2. Replaces the old unique customer index (companyId + email) with a partial one that ignores
 *    customers that have no email.
 *
 * Back up the database first. Requires MONGO_URI in the environment (same as the server).
 */
require("dotenv").config();
const mongoose = require("mongoose");
const config = require("../src/config/config");
const Role = require("../src/models/Role");
const Customer = require("../src/models/Customer");

const apply = process.argv.includes("--apply");

async function main() {
  await mongoose.connect(config.MONGO_URI);
  console.log(apply ? "APPLY mode" : "DRY RUN (add --apply to change data)");

  const legacyRoles = await Role.find({ slug: "super-admin" }).select("_id companyId name").lean();
  console.log(`Roles with slug "super-admin": ${legacyRoles.length}`);
  if (apply && legacyRoles.length) {
    const result = await Role.updateMany({ slug: "super-admin" }, { $set: { slug: "owner", name: "Owner" } });
    console.log(`Renamed ${result.modifiedCount} role(s) to "owner".`);
  }

  const collection = Customer.collection;
  const indexes = await collection.indexes();
  const oldIndex = indexes.find((i) => i.name === "companyId_1_email_1");
  console.log(oldIndex ? 'Old index "companyId_1_email_1" found.' : "Old customer email index not present.");
  if (apply) {
    if (oldIndex) {
      await collection.dropIndex("companyId_1_email_1");
      console.log("Dropped old index.");
    }
    await Customer.syncIndexes();
    console.log("Created the partial unique index.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
