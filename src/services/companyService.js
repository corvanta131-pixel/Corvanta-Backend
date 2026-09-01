const Company = require("../models/Company");
const AppError = require("../utils/AppError");

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function createCompany({ name, industry = "", regionId = null, countryId = null, cityId = null, ownerId = null }) {
  const companyName = String(name || "").trim();

  if (!companyName) {
    throw new AppError(400, "Company name is required.");
  }

  const slug = slugify(companyName);

  if (!slug) {
    throw new AppError(400, "Company name must contain valid characters.");
  }

  const company = await Company.create({
    name: companyName,
    slug,
    industry,
    regionId,
    countryId,
    cityId,
    ownerId,
    status: "trial",
  });

  return company;
}

async function getCompaniesForUser(companyIds = []) {
  return Company.find({ _id: { $in: companyIds }, isDeleted: false }).lean();
}

module.exports = {
  createCompany,
  getCompaniesForUser,
};
